# S3 Metadata Handling

## The Solution

S3 presigned URLs handle metadata differently than Google Cloud Storage, but we can achieve the same result using **POST presigned URLs** instead of PUT presigned URLs.

1. **GCS**: Can include custom headers in signed URLs that are automatically applied
2. **S3 PUT**: Requires exact headers to be sent by the client if they're part of the signature (causes 403 errors)
3. **S3 POST**: Supports form fields including metadata without signature issues

## Previous Challenge (Now Resolved)

The old approach using PUT presigned URLs caused this error:
```
<Error>
  <Code>AccessDenied</Code>
  <Message>There were headers present in the request which were not signed</Message>
  <HeadersNotSigned>x-amz-meta-customtime, x-amz-meta-uploaderidentitykey</HeadersNotSigned>
</Error>
```

## Our Current Solution

We use **POST presigned URLs with form fields** for S3:

### Single-Phase Upload (via POST presigned URL)
- Generate a POST presigned URL with form fields including metadata
- Client uploads the file using `multipart/form-data` POST request
- Metadata is included directly in the form fields:
  - `x-amz-meta-uploaderidentitykey`: Identity of uploader
  - `x-amz-meta-customtime`: Expiry time + 5 minutes
- S3 event handler can process file immediately (like GCS)

## Code Flow

1. **Client requests upload URL**:
   ```javascript
   POST /upload
   {
     "fileSize": 1024,
     "retentionPeriod": 60
   }
   ```

2. **Server returns POST presigned URL** (S3 version):
   ```javascript
   {
     "uploadURL": "https://bucket.s3.amazonaws.com/",
     "requiredHeaders": {
       "content-type": "multipart/form-data"
     },
     "formFields": {
       "key": "cdn/object-identifier",
       "x-amz-meta-uploaderidentitykey": "uploader-key",
       "x-amz-meta-customtime": "2024-01-01T00:00:00.000Z",
       "policy": "...",
       "x-amz-algorithm": "AWS4-HMAC-SHA256",
       "x-amz-credential": "...",
       "x-amz-date": "...",
       "x-amz-signature": "..."
     }
   }
   ```

3. **Client uploads file using POST**:
   ```javascript
   POST [uploadURL]
   Content-Type: multipart/form-data
   
   FormData: {
     ...formFields,
     "file": [file data]
   }
   ```

4. **S3 event handler processes file automatically**:
   - File uploaded with metadata already present
   - Event handler finds `uploaderidentitykey` in metadata
   - Calls `/advertise` endpoint automatically
   - Creates UHRP advertisement

## Comparison with GCS

### GCS Approach:
- Metadata included in signed PUT URL headers
- Single-step process
- Client must send exact headers

### S3 Approach (Current):
- Metadata included in POST form fields
- Single-step process (like GCS!)
- Client uploads using multipart/form-data
- S3 event handler processes automatically

## Benefits

1. **GCS-like Behavior**: Metadata available immediately after upload
2. **Automatic Processing**: S3 event handler can process files without manual `/advertise` calls
3. **No 403 Errors**: POST presigned URLs avoid signature mismatch issues
4. **Consistent Workflow**: Both GCS and S3 now follow the same pattern

## Technical Details

### POST vs PUT Presigned URLs

- **PUT Presigned URLs**: Require exact header matching, causing 403 errors with metadata
- **POST Presigned URLs**: Use form fields, avoiding signature validation issues

### Client Implementation

Clients now need to:
1. Use POST instead of PUT
2. Set `Content-Type: multipart/form-data`
3. Include all form fields from the response
4. Add the file as a form field named "file"

This approach successfully replicates GCS behavior while working within S3's constraints.