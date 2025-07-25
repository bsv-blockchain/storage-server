import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  StorageProvider,
  UploadParams,
  UploadResponse,
  ObjectMetadata,
  ListObjectsParams,
  ListObjectsResponse,
  ObjectInfo
} from '../types'

export class S3StorageProvider implements StorageProvider {
  private s3Client: S3Client
  private bucketName: string

  constructor() {
    const { AWS_REGION, AWS_BUCKET_NAME, STORAGE_BUCKET_NAME } = process.env
    
    // Support both old and new env var names
    this.bucketName = STORAGE_BUCKET_NAME || AWS_BUCKET_NAME || ''
    
    if (!this.bucketName) {
      throw new Error('Missing required AWS S3 bucket name environment variable.')
    }

    this.s3Client = new S3Client({
      region: AWS_REGION || 'us-west-2',
      // Credentials are automatically loaded from IAM role in ECS/EKS
    })
  }

  async generateUploadURL({
    size,
    expiryTime,
    objectIdentifier,
    uploaderIdentityKey
  }: UploadParams): Promise<UploadResponse> {
    const objectKey = `cdn/${objectIdentifier}`
    
    // Calculate the custom time (e.g., expiry time plus 5 minutes)
    const customTime = new Date((expiryTime + 300) * 1000).toISOString()
    
    // Include metadata in the presigned URL so it's available to the event handler
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentLength: size,
      // Include metadata that will be stored with the object
      Metadata: {
        'uploaderidentitykey': uploaderIdentityKey,
        'customtime': customTime
      }
    })
    
    // Generate presigned URL
    const uploadURL = await getSignedUrl(this.s3Client, command, {
      expiresIn: 604800 // 1 week in seconds
    })
    
    // Return the URL with required headers
    // The client must include these headers exactly as specified
    return {
      uploadURL,
      requiredHeaders: {
        'content-length': size.toString(),
        'x-amz-meta-uploaderidentitykey': uploaderIdentityKey,
        'x-amz-meta-customtime': customTime
      }
    }
  }

  async getObjectMetadata(objectKey: string): Promise<ObjectMetadata> {
    const command = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey
    })
    
    const response = await this.s3Client.send(command)
    
    return {
      size: response.ContentLength || 0,
      contentType: response.ContentType || 'application/octet-stream',
      lastModified: response.LastModified || new Date(),
      customMetadata: response.Metadata || {}
    }
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.getObjectMetadata(objectKey)
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey
    })
    
    await this.s3Client.send(command)
  }

  async listObjects({ prefix, maxKeys = 1000, continuationToken }: ListObjectsParams): Promise<ListObjectsResponse> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken
    })
    
    const response = await this.s3Client.send(command)
    
    const objects: ObjectInfo[] = (response.Contents || []).map(obj => ({
      key: obj.Key || '',
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date()
    }))
    
    return {
      objects,
      continuationToken: response.NextContinuationToken,
      isTruncated: response.IsTruncated || false
    }
  }

  async generateDownloadURL(objectKey: string, expiresIn: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey
    })
    
    return await getSignedUrl(this.s3Client, command, { expiresIn })
  }

  async downloadObject(objectKey: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey
    })
    
    const response = await this.s3Client.send(command)
    
    // Convert stream to buffer
    const chunks: Uint8Array[] = []
    const stream = response.Body as any
    
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    
    return Buffer.concat(chunks)
  }

  async updateObjectMetadata(objectKey: string, metadata: { customTime?: string; [key: string]: any }): Promise<void> {
    // S3 doesn't support updating metadata without copying the object
    // We need to copy the object to itself with new metadata
    
    // First, get current object metadata
    const headCommand = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey
    })
    
    const currentObject = await this.s3Client.send(headCommand)
    
    // Prepare new metadata
    const newMetadata: { [key: string]: string } = {
      ...(currentObject.Metadata || {})
    }
    
    if (metadata.customTime) {
      newMetadata.customtime = metadata.customTime
    }
    
    // Add other metadata fields
    Object.keys(metadata).forEach(key => {
      if (key !== 'customTime') {
        newMetadata[key.toLowerCase()] = String(metadata[key])
      }
    })
    
    // Copy object to itself with new metadata
    const copyCommand = new CopyObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      CopySource: `${this.bucketName}/${objectKey}`,
      Metadata: newMetadata,
      MetadataDirective: 'REPLACE',
      ContentType: currentObject.ContentType
    })
    
    await this.s3Client.send(copyCommand)
  }

  getProviderName(): string {
    return 'aws'
  }
}