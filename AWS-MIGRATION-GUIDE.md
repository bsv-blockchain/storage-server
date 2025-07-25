# AWS Migration Guide - Code Modifications

This guide details the code changes required to migrate the UHRP Storage Server from Google Cloud Platform (GCP) to Amazon Web Services (AWS).

## Overview

The main changes involve:
1. Replacing Google Cloud Storage with AWS S3
2. Updating environment variables
3. Modifying the Lambda function handler
4. Adjusting authentication and configuration

## Required Dependencies

First, update your `package.json` to include AWS SDK v3:

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.0.0",
    "@aws-sdk/s3-request-presigner": "^3.0.0",
    "@aws-sdk/lib-storage": "^3.0.0"
  }
}
```

Remove the GCP dependency:
```bash
npm uninstall @google-cloud/storage
```

## Environment Variable Mapping

| GCP Variable | AWS Variable | Notes |
|--------------|--------------|-------|
| `GCS_BUCKET_NAME` | `AWS_BUCKET_NAME` | S3 bucket name |
| `GCS_BUCKET_EXTRA_TIME` | `S3_RETENTION_DAYS` | Convert to days |
| `GCS_KEY_FILE` | Not needed | Use IAM roles |
| `GCS_KEY_VALUE` | Not needed | Use IAM roles |
| `GCP_PROJECT_ID` | `AWS_REGION` | AWS region |
| `GCP_STORAGE_CREDS` | Not needed | Use IAM roles |

## Code Modifications

### 1. Storage Client Initialization

**Original (GCP):**
```javascript
// src/utilities/storage.js
const { Storage } = require('@google-cloud/storage');

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCS_KEY_FILE,
  credentials: process.env.GCS_KEY_VALUE ? JSON.parse(process.env.GCS_KEY_VALUE) : undefined
});

const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
```

**New (AWS):**
```javascript
// src/utilities/storage.js
const { S3Client } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-west-2',
  // Credentials are automatically loaded from IAM role in ECS/Lambda
});

const bucketName = process.env.AWS_BUCKET_NAME;
```

### 2. File Upload

**Original (GCP):**
```javascript
// src/controllers/upload.js
async function uploadFile(file, fileName) {
  const blob = bucket.file(fileName);
  const stream = blob.createWriteStream({
    metadata: {
      contentType: file.mimetype,
    },
  });

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => {
      blob.makePublic().then(() => {
        resolve(`https://storage.googleapis.com/${bucket.name}/${fileName}`);
      });
    });
    stream.end(file.buffer);
  });
}
```

**New (AWS):**
```javascript
// src/controllers/upload.js
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

async function uploadFile(file, fileName) {
  // For small files
  if (file.size < 5 * 1024 * 1024) { // 5MB
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      // S3 doesn't have makePublic, use bucket policy or presigned URLs
    });
    
    await s3Client.send(command);
    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
  } else {
    // For large files, use multipart upload
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: fileName,
        Body: file.stream,
        ContentType: file.mimetype,
      },
    });

    await upload.done();
    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
  }
}
```

### 3. File Download

**Original (GCP):**
```javascript
// src/controllers/download.js
async function downloadFile(fileName) {
  const file = bucket.file(fileName);
  const [exists] = await file.exists();
  
  if (!exists) {
    throw new Error('File not found');
  }
  
  const [metadata] = await file.getMetadata();
  const stream = file.createReadStream();
  
  return {
    stream,
    contentType: metadata.contentType,
    size: metadata.size
  };
}
```

**New (AWS):**
```javascript
// src/controllers/download.js
const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

async function downloadFile(fileName) {
  try {
    // Check if file exists and get metadata
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: fileName
    });
    
    const metadata = await s3Client.send(headCommand);
    
    // Get the file
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: fileName
    });
    
    const response = await s3Client.send(getCommand);
    
    return {
      stream: response.Body,
      contentType: response.ContentType,
      size: response.ContentLength
    };
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      throw new Error('File not found');
    }
    throw error;
  }
}
```

### 4. File Deletion

**Original (GCP):**
```javascript
// src/controllers/delete.js
async function deleteFile(fileName) {
  const file = bucket.file(fileName);
  await file.delete();
}
```

**New (AWS):**
```javascript
// src/controllers/delete.js
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');

async function deleteFile(fileName) {
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: fileName
  });
  
  await s3Client.send(command);
}
```

### 5. Generate Signed URLs

**Original (GCP):**
```javascript
async function getSignedUrl(fileName, expiresIn = 3600) {
  const options = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresIn * 1000,
  };
  
  const [url] = await bucket.file(fileName).getSignedUrl(options);
  return url;
}
```

**New (AWS):**
```javascript
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

async function getSignedUrl(fileName, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileName
  });
  
  const url = await getSignedUrl(s3Client, command, { expiresIn });
  return url;
}
```

### 6. Lambda Function Handler

**Original (GCP Cloud Function):**
```javascript
// notifier/index.js
exports.notifier = async (file, context) => {
  const bucketName = file.bucket;
  const fileName = file.name;
  
  console.log(`File ${fileName} uploaded to ${bucketName}`);
  
  // Process the file
  await processFile(bucketName, fileName);
};
```

**New (AWS Lambda):**
```javascript
// notifier/index.js
exports.notifier = async (event, context) => {
  // Lambda receives S3 events in a different format
  for (const record of event.Records) {
    const bucketName = record.s3.bucket.name;
    const fileName = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const eventName = record.eventName;
    
    console.log(`Event ${eventName} for file ${fileName} in bucket ${bucketName}`);
    
    if (eventName.startsWith('ObjectCreated:')) {
      await processFile(bucketName, fileName);
    }
  }
  
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Success' })
  };
};
```

### 7. Stream Handling

**Original (GCP):**
```javascript
// Streaming uploads
const stream = bucket.file(fileName).createWriteStream();
fileStream.pipe(stream);
```

**New (AWS):**
```javascript
// For streaming uploads, use the Upload class
const { Upload } = require('@aws-sdk/lib-storage');

const upload = new Upload({
  client: s3Client,
  params: {
    Bucket: bucketName,
    Key: fileName,
    Body: fileStream,
    ContentType: 'application/octet-stream'
  }
});

await upload.done();
```

### 8. Bucket Policy (Replace makePublic)

Since S3 doesn't have a `makePublic()` method, you need to set a bucket policy for public access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-bucket-name/public/*"
    }
  ]
}
```

Or use CloudFront for better performance and security.

### 9. Error Handling

**Original (GCP):**
```javascript
try {
  await file.save(data);
} catch (error) {
  if (error.code === 404) {
    // File not found
  }
}
```

**New (AWS):**
```javascript
try {
  await s3Client.send(command);
} catch (error) {
  if (error.name === 'NoSuchKey') {
    // File not found
  } else if (error.name === 'NoSuchBucket') {
    // Bucket not found
  }
  // AWS errors have different structure
  console.error('AWS Error:', error.$metadata?.httpStatusCode, error.name);
}
```

### 10. Configuration Updates

Update your server initialization to remove GCS-specific configurations:

```javascript
// src/server.js
// Remove GCS initialization
// Add AWS SDK v3 doesn't require explicit initialization

// Update health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check S3 access
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    res.json({ status: 'healthy', storage: 'aws-s3' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});
```

## Testing the Migration

1. **Unit Tests**: Update your tests to mock AWS SDK instead of GCP:
```javascript
// Mock AWS SDK
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn()
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn()
}));
```

2. **Integration Tests**: Use LocalStack for testing S3 locally:
```bash
docker run -d \
  --name localstack \
  -p 4566:4566 \
  -e SERVICES=s3 \
  localstack/localstack
```

3. **Environment Setup for Local Development**:
```javascript
// For local development with LocalStack
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-west-2',
  endpoint: process.env.S3_ENDPOINT || undefined, // http://localhost:4566 for LocalStack
  forcePathStyle: true // Required for LocalStack
});
```

## Performance Optimizations

1. **Use S3 Transfer Acceleration** for better upload speeds:
```javascript
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  useAccelerateEndpoint: true
});
```

2. **Implement S3 Multipart Upload** for large files (shown above)

3. **Use CloudFront** for content delivery:
```javascript
const cloudfrontUrl = `https://${process.env.CLOUDFRONT_DOMAIN}/${fileName}`;
```

## Security Considerations

1. **Use IAM Roles** instead of access keys in production
2. **Enable S3 Bucket Encryption**:
```javascript
const command = new PutObjectCommand({
  Bucket: bucketName,
  Key: fileName,
  Body: file.buffer,
  ServerSideEncryption: 'AES256'
});
```

3. **Implement bucket policies** for access control
4. **Use VPC Endpoints** for private S3 access

## Rollback Plan

If you need to rollback to GCP:
1. Keep the original GCS code in a separate branch
2. Use environment variables to switch between AWS and GCP
3. Implement a storage abstraction layer

## Common Issues and Solutions

1. **CORS Issues**: Ensure S3 CORS configuration matches your needs
2. **Permission Errors**: Check IAM roles and bucket policies
3. **Region Mismatches**: Ensure all services are in the same region
4. **Large File Uploads**: Use multipart upload for files > 5MB
5. **Public Access**: S3 blocks public access by default - update bucket policy

## Monitoring and Debugging

1. **CloudWatch Logs**: All S3 operations are logged
2. **X-Ray Tracing**: Add AWS X-Ray for distributed tracing
3. **S3 Access Logs**: Enable S3 access logging for audit trails

```javascript
// Add X-Ray tracing
const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));
```

This completes the code migration from GCP to AWS. Test thoroughly in a staging environment before deploying to production.