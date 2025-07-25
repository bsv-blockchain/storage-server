import { Storage } from '@google-cloud/storage'
import path from 'path'
import {
  StorageProvider,
  UploadParams,
  UploadResponse,
  ObjectMetadata,
  ListObjectsParams,
  ListObjectsResponse,
  ObjectInfo
} from '../types'

export class GCSStorageProvider implements StorageProvider {
  private storage: Storage
  private bucket: any
  private bucketName: string

  constructor() {
    const { GCP_PROJECT_ID, GCP_BUCKET_NAME, STORAGE_BUCKET_NAME } = process.env
    
    // Support both old and new env var names
    this.bucketName = STORAGE_BUCKET_NAME || GCP_BUCKET_NAME || ''
    
    if (!this.bucketName || !GCP_PROJECT_ID) {
      throw new Error('Missing required Google Cloud Storage environment variables.')
    }

    const serviceKey = path.join(__dirname, '../../../../storage-creds.json')
    this.storage = new Storage({
      keyFilename: serviceKey,
      projectId: GCP_PROJECT_ID
    })
    
    this.bucket = this.storage.bucket(this.bucketName)
  }

  async generateUploadURL({
    size,
    expiryTime,
    objectIdentifier,
    uploaderIdentityKey
  }: UploadParams): Promise<UploadResponse> {
    const bucketFile = this.bucket.file(`cdn/${objectIdentifier}`)
    
    // Calculate the custom time (e.g., expiry time plus 5 minutes)
    const customTime = new Date((expiryTime + 300) * 1000).toISOString()
    
    // Generate the signed URL including the metadata headers.
    // The extensionHeaders are part of the signature and must be included by the client in the PUT request.
    const [uploadURL] = await bucketFile.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 604000 * 1000, // 1 week
      extensionHeaders: {
        'content-length': size.toString(),
        'x-goog-meta-uploaderidentitykey': uploaderIdentityKey,
        'x-goog-custom-time': customTime
      }
    })
    
    return {
      uploadURL,
      requiredHeaders: {
        'content-length': size.toString(),
        'x-goog-meta-uploaderidentitykey': uploaderIdentityKey,
        'x-goog-custom-time': customTime
      }
    }
  }

  async getObjectMetadata(objectKey: string): Promise<ObjectMetadata> {
    const file = this.bucket.file(objectKey)
    const [metadata] = await file.getMetadata()
    
    return {
      size: parseInt(metadata.size, 10),
      contentType: metadata.contentType || 'application/octet-stream',
      lastModified: new Date(metadata.updated || metadata.timeCreated),
      customMetadata: metadata.metadata || {}
    }
  }

  async objectExists(objectKey: string): Promise<boolean> {
    const file = this.bucket.file(objectKey)
    const [exists] = await file.exists()
    return exists
  }

  async deleteObject(objectKey: string): Promise<void> {
    const file = this.bucket.file(objectKey)
    await file.delete()
  }

  async listObjects({ prefix, maxKeys = 1000, continuationToken }: ListObjectsParams): Promise<ListObjectsResponse> {
    const options: any = {
      prefix,
      maxResults: maxKeys
    }
    
    if (continuationToken) {
      options.pageToken = continuationToken
    }
    
    const [files, nextQuery] = await this.bucket.getFiles(options)
    
    const objects: ObjectInfo[] = files.map((file: any) => ({
      key: file.name,
      size: parseInt(file.metadata.size, 10),
      lastModified: new Date(file.metadata.updated || file.metadata.timeCreated)
    }))
    
    return {
      objects,
      continuationToken: nextQuery?.pageToken,
      isTruncated: !!nextQuery?.pageToken
    }
  }

  async generateDownloadURL(objectKey: string, expiresIn: number): Promise<string> {
    const file = this.bucket.file(objectKey)
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresIn * 1000
    })
    return url
  }

  async downloadObject(objectKey: string): Promise<Buffer> {
    const file = this.bucket.file(objectKey)
    const [buffer] = await file.download()
    return buffer
  }

  async updateObjectMetadata(objectKey: string, metadata: { customTime?: string; [key: string]: any }): Promise<void> {
    const file = this.bucket.file(objectKey)
    
    // GCS uses setMetadata to update metadata
    const gcsMetadata: any = {}
    
    if (metadata.customTime) {
      gcsMetadata.customTime = metadata.customTime
    }
    
    // Map other metadata fields if needed
    Object.keys(metadata).forEach(key => {
      if (key !== 'customTime') {
        gcsMetadata[key] = metadata[key]
      }
    })
    
    await file.setMetadata(gcsMetadata)
  }

  getProviderName(): string {
    return 'gcs'
  }
}