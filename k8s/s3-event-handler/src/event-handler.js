const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { StorageUtils } = require('@bsv/sdk');
const { 
  S3Client, 
  GetObjectCommand,
  HeadObjectCommand 
} = require('@aws-sdk/client-s3');
const { 
  SQSClient, 
  ReceiveMessageCommand, 
  DeleteMessageCommand 
} = require('@aws-sdk/client-sqs');

// Environment variables
const {
  NODE_ENV,
  AWS_REGION,
  AWS_BUCKET_NAME,
  SQS_QUEUE_URL,
  SQS_MAX_MESSAGES = '10',
  SQS_WAIT_TIME_SECONDS = '20',
  HOSTING_DOMAIN,
  ADMIN_TOKEN,
  SERVER_PRIVATE_KEY
} = process.env;

// Initialize AWS clients
const s3Client = new S3Client({ region: AWS_REGION });
const sqsClient = new SQSClient({ region: AWS_REGION });

// Express app for health checks and metrics
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'event-handler' });
});

// Readiness check endpoint
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', service: 'event-handler' });
});

// Metrics endpoint (could be expanded with Prometheus metrics)
app.get('/metrics', (req, res) => {
  res.type('text/plain');
  res.send(`# HELP processed_events_total Total number of processed events
# TYPE processed_events_total counter
processed_events_total ${processedEvents}

# HELP processing_errors_total Total number of processing errors
# TYPE processing_errors_total counter
processing_errors_total ${processingErrors}
`);
});

// Manual notification endpoint (for testing or manual triggers)
app.post('/notify', async (req, res) => {
  try {
    const { bucket, key } = req.body;
    await processS3Object(bucket, key);
    res.json({ success: true, message: 'Notification processed' });
  } catch (error) {
    console.error('Manual notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Metrics
let processedEvents = 0;
let processingErrors = 0;

// Start HTTP server for health checks
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`Event handler HTTP server listening on port ${PORT}`);
});

// Process S3 object
async function processS3Object(bucketName, objectKey) {
  console.log(`Processing S3 object: ${bucketName}/${objectKey}`);
  
  // Only process files in cdn/ folder
  if (!objectKey.startsWith('cdn/')) {
    console.log('Skipping non-CDN file:', objectKey);
    return;
  }

  try {
    // Get object metadata
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    });
    const metadata = await s3Client.send(headCommand);
    
    console.log('S3 Object Metadata:', {
      ContentLength: metadata.ContentLength,
      ContentType: metadata.ContentType,
      LastModified: metadata.LastModified,
      Metadata: metadata.Metadata
    });
    
    // Extract uploader identity key from metadata
    let uploaderIdentityKey = '';
    if (metadata.Metadata && metadata.Metadata.uploaderidentitykey) {
      uploaderIdentityKey = metadata.Metadata.uploaderidentitykey;
      console.log('Found uploaderIdentityKey in metadata:', uploaderIdentityKey);
    } else {
      console.warn('WARNING: uploaderidentitykey not found in S3 metadata for object:', objectKey);
      console.warn('Available metadata keys:', Object.keys(metadata.Metadata || {}));
      // Skip processing if no uploader identity key
      console.error('Cannot process file without uploaderIdentityKey. File needs to be uploaded with proper metadata.');
      throw new Error('Missing uploaderIdentityKey in S3 metadata');
    }
    
    // Get expiry time from custom metadata
    const expiryTime = metadata.Metadata?.customtime 
      ? Math.round(new Date(metadata.Metadata.customtime).getTime() / 1000)
      : Math.round(Date.now() / 1000) + (30 * 24 * 60 * 60); // Default 30 days
    
    if (!metadata.Metadata?.customtime) {
      console.warn('No customtime found in metadata, using default expiry of 30 days');
    }
    
    // Get the object to calculate hash
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    });
    const response = await s3Client.send(getCommand);
    
    // Calculate SHA256 hash
    const hash = crypto.createHash('sha256');
    const stream = response.Body;
    
    // Convert stream to buffer and calculate hash
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      hash.update(chunk);
    }
    
    const fileHash = hash.digest();
    const uhrpUrl = StorageUtils.getURLForHash(fileHash);
    
    console.log('Generated UHRP URL:', uhrpUrl);
    
    // Extract object identifier from path
    const objectIdentifier = objectKey.split('/').pop();
    
    // Send notification to advertise endpoint
    const notificationData = {
      adminToken: ADMIN_TOKEN,
      uhrpUrl,
      uploaderIdentityKey,
      objectIdentifier,
      expiryTime,
      fileSize: metadata.ContentLength
    };
    
    console.log('Sending notification:', notificationData);
    
    await axios.post(
      `${HOSTING_DOMAIN}/advertise`,
      notificationData,
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Successfully advertised file:', objectKey);
    processedEvents++;
    
  } catch (error) {
    console.error('Error processing S3 object:', error);
    processingErrors++;
    throw error;
  }
}

// Process SQS message
async function processMessage(message) {
  try {
    const body = JSON.parse(message.Body);
    
    // Handle S3 event notification
    if (body.Records) {
      for (const record of body.Records) {
        if (record.eventName.startsWith('ObjectCreated:')) {
          const bucketName = record.s3.bucket.name;
          const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
          
          await processS3Object(bucketName, objectKey);
        }
      }
    }
    
    // Delete message from queue after successful processing
    const deleteCommand = new DeleteMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      ReceiptHandle: message.ReceiptHandle
    });
    await sqsClient.send(deleteCommand);
    
  } catch (error) {
    console.error('Error processing message:', error);
    processingErrors++;
    // Don't delete message on error - let it retry
  }
}

// Main polling loop
async function pollSQS() {
  while (true) {
    try {
      // Receive messages from SQS
      const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: parseInt(SQS_MAX_MESSAGES),
        WaitTimeSeconds: parseInt(SQS_WAIT_TIME_SECONDS),
        MessageAttributeNames: ['All']
      });
      
      const response = await sqsClient.send(receiveCommand);
      
      if (response.Messages && response.Messages.length > 0) {
        console.log(`Received ${response.Messages.length} messages from SQS`);
        
        // Process messages in parallel
        await Promise.all(
          response.Messages.map(message => processMessage(message))
        );
      }
      
    } catch (error) {
      console.error('Error polling SQS:', error);
      processingErrors++;
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start polling SQS
console.log('Starting S3 event handler...');
console.log('SQS Queue URL:', SQS_QUEUE_URL);
console.log('S3 Bucket:', AWS_BUCKET_NAME);
pollSQS().catch(error => {
  console.error('Fatal error in polling loop:', error);
  process.exit(1);
});