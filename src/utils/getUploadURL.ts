import { getStorageProvider, UploadParams, UploadResponse } from './storage'

const { NODE_ENV } = process.env

const devUploadFunction = (): Promise<UploadResponse> => {
  console.log('[DEV] Returning pretend upload URL http://localhost:8080/upload')
  return Promise.resolve({ 
    uploadURL: 'http://localhost:8080/upload', 
    requiredHeaders: {},
    formFields: undefined 
  })
}

/**
 * Creates a signed URL for uploading an object to the configured storage provider.
 * The signed URL includes metadata headers that must be provided by the client.
 *
 * @param {UploadParams} params - Parameters for file upload.
 * @returns {Promise<UploadResponse>} - The signed upload URL.
 *
 * Note: The client must include the required headers in the PUT request.
 * Different storage providers have different header requirements.
 */
const prodUploadFunction = async (params: UploadParams): Promise<UploadResponse> => {
  const storage = getStorageProvider()
  return storage.generateUploadURL(params)
}

export default NODE_ENV === 'development' ? devUploadFunction : prodUploadFunction