import { StorageProvider, StorageProviderType } from './types'
import { GCSStorageProvider } from './providers/gcs'
import { S3StorageProvider } from './providers/s3'

let storageProvider: StorageProvider | null = null

/**
 * Get the configured storage provider instance
 * Uses singleton pattern to avoid re-initializing the provider
 */
export function getStorageProvider(): StorageProvider {
  if (!storageProvider) {
    const providerType = (process.env.STORAGE_PROVIDER || 'gcs').toLowerCase() as StorageProviderType
    
    console.log(`Initializing storage provider: ${providerType}`)
    
    switch (providerType) {
      case 'gcs':
        storageProvider = new GCSStorageProvider()
        break
      case 'aws':
        storageProvider = new S3StorageProvider()
        break
      default:
        throw new Error(`Unsupported storage provider: ${providerType}. Supported values: 'gcs', 'aws'`)
    }
  }
  
  return storageProvider
}

/**
 * Reset the storage provider instance (useful for testing)
 */
export function resetStorageProvider(): void {
  storageProvider = null
}

// Re-export types for convenience
export * from './types'