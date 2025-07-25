# Storage Abstraction Layer

This storage abstraction layer provides a unified interface for working with multiple cloud storage providers (currently AWS S3 and Google Cloud Storage).

## Configuration

Set the `STORAGE_PROVIDER` environment variable to choose your storage backend:
- `aws` - Amazon S3
- `gcs` - Google Cloud Storage

## Usage

```typescript
import { getStorageProvider } from './utils/storage'

// Get the configured storage provider
const storage = getStorageProvider()

// Generate upload URL
const { uploadURL, requiredHeaders } = await storage.generateUploadURL({
  size: 1024,
  expiryTime: Math.floor(Date.now() / 1000) + 3600,
  objectIdentifier: 'unique-id',
  uploaderIdentityKey: 'user-key'
})

// Get object metadata
const metadata = await storage.getObjectMetadata('cdn/object-id')

// Update object metadata
await storage.updateObjectMetadata('cdn/object-id', {
  customTime: new Date().toISOString()
})

// Check if object exists
const exists = await storage.objectExists('cdn/object-id')

// Generate download URL
const downloadUrl = await storage.generateDownloadURL('cdn/object-id', 3600)
```

## Environment Variables

### Common Variables
- `STORAGE_PROVIDER` - Choose between 'aws' or 'gcs'
- `STORAGE_BUCKET_NAME` - Bucket name (works for both providers)

### AWS S3 Configuration
- `AWS_REGION` - AWS region (default: us-west-2)
- `AWS_BUCKET_NAME` - S3 bucket name (fallback if STORAGE_BUCKET_NAME not set)
- AWS credentials are automatically loaded from IAM roles or AWS CLI configuration

### Google Cloud Storage Configuration
- `GCP_PROJECT_ID` - Google Cloud project ID
- `GCP_BUCKET_NAME` - GCS bucket name (fallback if STORAGE_BUCKET_NAME not set)
- Credentials file should be at `./storage-creds.json`

## Adding New Storage Providers

To add a new storage provider:

1. Create a new provider class in `providers/` that implements the `StorageProvider` interface
2. Add the provider type to `StorageProviderType` in `types.ts`
3. Update the factory in `index.ts` to instantiate your provider

Example:
```typescript
export class AzureStorageProvider implements StorageProvider {
  // Implement all required methods
}
```

## Migration Guide

### From Direct GCS Usage

Before:
```typescript
const storage = new Storage()
const bucket = storage.bucket(GCP_BUCKET_NAME)
const file = bucket.file('cdn/file-id')
```

After:
```typescript
const storage = getStorageProvider()
const metadata = await storage.getObjectMetadata('cdn/file-id')
```

### Environment Variable Changes

The system supports both old and new environment variable names for backward compatibility:
- `GCP_BUCKET_NAME` → `STORAGE_BUCKET_NAME`
- `AWS_BUCKET_NAME` → `STORAGE_BUCKET_NAME`

Set `STORAGE_PROVIDER` to choose which backend to use.