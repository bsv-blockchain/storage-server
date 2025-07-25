/**
 * Storage provider abstraction layer for multi-cloud support
 */

export interface UploadParams {
  size: number
  expiryTime: number
  objectIdentifier: string
  uploaderIdentityKey: string
}

export interface UploadResponse {
  uploadURL: string
  requiredHeaders: Record<string, string>
}

export interface ObjectMetadata {
  size: number
  contentType: string
  lastModified: Date
  customMetadata: Record<string, string>
}

export interface ObjectInfo {
  key: string
  size: number
  lastModified: Date
}

export interface ListObjectsParams {
  prefix?: string
  maxKeys?: number
  continuationToken?: string
}

export interface ListObjectsResponse {
  objects: ObjectInfo[]
  continuationToken?: string
  isTruncated: boolean
}

/**
 * Abstract interface for storage providers (GCS, S3, etc.)
 */
export interface StorageProvider {
  /**
   * Generate a signed URL for uploading an object
   */
  generateUploadURL(params: UploadParams): Promise<UploadResponse>

  /**
   * Get metadata for an object
   */
  getObjectMetadata(objectKey: string): Promise<ObjectMetadata>

  /**
   * Check if an object exists
   */
  objectExists(objectKey: string): Promise<boolean>

  /**
   * Delete an object
   */
  deleteObject(objectKey: string): Promise<void>

  /**
   * List objects with optional prefix
   */
  listObjects(params: ListObjectsParams): Promise<ListObjectsResponse>

  /**
   * Get a signed URL for downloading an object
   */
  generateDownloadURL(objectKey: string, expiresIn: number): Promise<string>

  /**
   * Download an object and return its content
   */
  downloadObject(objectKey: string): Promise<Buffer>

  /**
   * Update metadata for an object
   */
  updateObjectMetadata(objectKey: string, metadata: { customTime?: string; [key: string]: any }): Promise<void>

  /**
   * Get the provider name
   */
  getProviderName(): string
}

export type StorageProviderType = 'gcs' | 'aws'