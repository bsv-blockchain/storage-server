# S3 Metadata Handling

## The Challenge

S3 presigned URLs handle metadata differently than Google Cloud Storage:

1. **GCS**: Can include custom headers in signed URLs that are automatically applied
2. **S3**: Requires exact headers to be sent by the client if they're part of the signature

## The Error

When trying to include metadata headers in S3 presigned URLs:
```
<Error>
  <Code>AccessDenied</Code>
  <Message>There were headers present in the request which were not signed</Message>
  <HeadersNotSigned>x-amz-meta-customtime, x-amz-meta-uploaderidentitykey</HeadersNotSigned>
</Error>
```

## Our Solution

We use a two-phase approach for S3:

### Phase 1: Upload (via presigned URL)
- Generate a simple presigned URL without metadata
- Client uploads the file using only `content-length` header
- No metadata headers required from client

### Phase 2: Metadata Update (via advertise endpoint)
- After successful upload, client calls `/advertise` endpoint
- Server adds metadata using `updateObjectMetadata`:
  - `customtime`: Expiry time + 5 minutes
  - `uploaderidentitykey`: Identity of uploader

## Code Flow

1. **Client requests upload URL**:
   ```javascript
   POST /upload
   {
     "fileSize": 1024,
     "retentionPeriod": 60
   }
   ```

2. **Server returns presigned URL** (S3 version):
   ```javascript
   {
     "uploadURL": "https://bucket.s3.amazonaws.com/...",
     "requiredHeaders": {
       "content-length": "1024"
     }
   }
   ```

3. **Client uploads file**:
   ```javascript
   PUT [uploadURL]
   Headers: {
     "content-length": "1024"
   }
   Body: [file data]
   ```

4. **Client calls advertise endpoint**:
   ```javascript
   POST /advertise
   {
     "adminToken": "...",
     "uhrpUrl": "...",
     "uploaderIdentityKey": "...",
     "objectIdentifier": "...",
     "fileSize": 1024,
     "expiryTime": 1234567890
   }
   ```

5. **Server updates metadata**:
   - Adds `customtime` and `uploaderidentitykey` to S3 object
   - Creates UHRP advertisement

## Differences from GCS

### GCS Approach:
- Metadata included in signed URL
- Single-step process
- Client must send exact headers

### S3 Approach:
- Metadata added post-upload
- Two-step process
- Simpler client implementation

## Benefits

1. **Simpler Client**: No need to handle complex metadata headers
2. **More Flexible**: Can update metadata without re-uploading
3. **Better Error Handling**: Upload and metadata are separate operations
4. **Consistent API**: Same client code works for both S3 and GCS

## Trade-offs

1. **Extra API Call**: Requires calling `/advertise` after upload
2. **Eventual Consistency**: Brief window where file exists without metadata
3. **Different from GCS**: Not a 1:1 feature match

## Future Improvements

If exact GCS-like behavior is needed for S3:

1. **Option 1**: Use POST with form data instead of PUT
2. **Option 2**: Implement custom signing logic
3. **Option 3**: Use S3 Transfer Acceleration with Lambda@Edge

For now, the two-phase approach provides the best balance of simplicity and functionality.