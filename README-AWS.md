# UHRP Storage Server – AWS Deployment Guide

This guide walks you through deploying the **UHRP Storage Server** on Amazon Web Services (AWS) with continuous delivery via GitHub Actions. This is an alternative to the GCP deployment covered in the main README.

## Overview

When complete, you'll have:

- An **S3 bucket** for storing UHRP data
- An **ECS Fargate** service running the containerized application
- A **Lambda function** for handling file upload notifications
- An **Application Load Balancer (ALB)** providing HTTPS access
- **GitHub Actions** for automated deployments

## GCP to AWS Service Mapping

| GCP Service | AWS Equivalent | Purpose |
|------------|----------------|---------|
| Cloud Storage | S3 | Object storage |
| Cloud Run | ECS Fargate | Container hosting |
| Cloud Functions | Lambda | Event processing |
| Artifact Registry | ECR | Container registry |
| Load Balancer | ALB | HTTPS routing |
| Cloud Build | CodeBuild | Build automation |
| Pub/Sub | EventBridge | Event routing |
| IAM | IAM | Access control |

## Prerequisites

- **AWS Account** with billing enabled
- **GitHub repository** containing your code
- **AWS CLI** installed and configured
- **Docker** installed locally
- **Domain name** (recommended for HTTPS)

## Phase 1: AWS Infrastructure Setup

### 1.1 Create S3 Bucket

```bash
# Set your AWS region and unique bucket name
export AWS_REGION=us-west-2
export BUCKET_NAME=my-uhrp-storage-$(date +%s)

# Create the bucket
aws s3api create-bucket \
    --bucket $BUCKET_NAME \
    --region $AWS_REGION \
    --create-bucket-configuration LocationConstraint=$AWS_REGION

# Enable bucket versioning (optional)
aws s3api put-bucket-versioning \
    --bucket $BUCKET_NAME \
    --versioning-configuration Status=Enabled

# Configure lifecycle rules for automatic deletion (optional)
cat > lifecycle.json << EOF
{
    "Rules": [
        {
            "ID": "DeleteOldFiles",
            "Status": "Enabled",
            "Expiration": {
                "Days": 30
            }
        }
    ]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
    --bucket $BUCKET_NAME \
    --lifecycle-configuration file://lifecycle.json
```

### 1.2 Configure S3 CORS

```bash
# Create CORS configuration
cat > s3-cors.json << EOF
{
    "CORSRules": [
        {
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
            "AllowedOrigins": ["*"],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3000
        }
    ]
}
EOF

# Apply CORS configuration
aws s3api put-bucket-cors \
    --bucket $BUCKET_NAME \
    --cors-configuration file://s3-cors.json
```

### 1.3 Create ECR Repository

```bash
# Create repository for Docker images
aws ecr create-repository \
    --repository-name uhrp-storage-server \
    --region $AWS_REGION

# Get the repository URI
export ECR_URI=$(aws ecr describe-repositories \
    --repository-names uhrp-storage-server \
    --region $AWS_REGION \
    --query 'repositories[0].repositoryUri' \
    --output text)
```

### 1.4 Create VPC and Networking (if needed)

```bash
# Create VPC
aws ec2 create-vpc --cidr-block 10.0.0.0/16 --query 'Vpc.VpcId' --output text
export VPC_ID=<output-from-above>

# Create subnets in different AZs
aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.1.0/24 \
    --availability-zone ${AWS_REGION}a \
    --query 'Subnet.SubnetId' --output text
export SUBNET_1=<output-from-above>

aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.2.0/24 \
    --availability-zone ${AWS_REGION}b \
    --query 'Subnet.SubnetId' --output text
export SUBNET_2=<output-from-above>

# Create Internet Gateway
aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text
export IGW_ID=<output-from-above>

aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID

# Create route table
aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text
export ROUTE_TABLE_ID=<output-from-above>

aws ec2 create-route \
    --route-table-id $ROUTE_TABLE_ID \
    --destination-cidr-block 0.0.0.0/0 \
    --gateway-id $IGW_ID

# Associate subnets with route table
aws ec2 associate-route-table --subnet-id $SUBNET_1 --route-table-id $ROUTE_TABLE_ID
aws ec2 associate-route-table --subnet-id $SUBNET_2 --route-table-id $ROUTE_TABLE_ID
```

## Phase 2: IAM Roles and Policies

### 2.1 Create ECS Task Execution Role

```bash
# Create trust policy
cat > ecs-trust-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "ecs-tasks.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF

# Create the role
aws iam create-role \
    --role-name uhrp-ecs-task-execution-role \
    --assume-role-policy-document file://ecs-trust-policy.json

# Attach AWS managed policy
aws iam attach-role-policy \
    --role-name uhrp-ecs-task-execution-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

### 2.2 Create ECS Task Role

```bash
# Create task role for application permissions
aws iam create-role \
    --role-name uhrp-ecs-task-role \
    --assume-role-policy-document file://ecs-trust-policy.json

# Create custom policy for S3 access
cat > s3-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::${BUCKET_NAME}",
                "arn:aws:s3:::${BUCKET_NAME}/*"
            ]
        }
    ]
}
EOF

# Create and attach the policy
aws iam create-policy \
    --policy-name uhrp-s3-access \
    --policy-document file://s3-policy.json

aws iam attach-role-policy \
    --role-name uhrp-ecs-task-role \
    --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/uhrp-s3-access
```

### 2.3 Create Lambda Execution Role

```bash
# Create Lambda trust policy
cat > lambda-trust-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "lambda.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF

# Create Lambda role
aws iam create-role \
    --role-name uhrp-lambda-execution-role \
    --assume-role-policy-document file://lambda-trust-policy.json

# Attach basic Lambda execution policy
aws iam attach-role-policy \
    --role-name uhrp-lambda-execution-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Attach S3 read policy
aws iam attach-role-policy \
    --role-name uhrp-lambda-execution-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
```

### 2.4 Create GitHub Actions User

```bash
# Create policy for GitHub Actions
cat > github-actions-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecr:PutImage",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ecs:UpdateService",
                "ecs:DescribeServices",
                "ecs:RegisterTaskDefinition",
                "ecs:DescribeTaskDefinition"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "iam:PassRole"
            ],
            "Resource": [
                "arn:aws:iam::*:role/uhrp-ecs-task-execution-role",
                "arn:aws:iam::*:role/uhrp-ecs-task-role"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "lambda:UpdateFunctionCode",
                "lambda:UpdateFunctionConfiguration"
            ],
            "Resource": "*"
        }
    ]
}
EOF

# Create IAM user for GitHub Actions
aws iam create-user --user-name github-actions-uhrp

# Create and attach policy
aws iam create-policy \
    --policy-name github-actions-uhrp-policy \
    --policy-document file://github-actions-policy.json

aws iam attach-user-policy \
    --user-name github-actions-uhrp \
    --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/github-actions-uhrp-policy

# Create access key
aws iam create-access-key --user-name github-actions-uhrp
# Save the AccessKeyId and SecretAccessKey for GitHub secrets
```

## Phase 3: ECS Setup

### 3.1 Create ECS Cluster

```bash
aws ecs create-cluster --cluster-name uhrp-cluster
```

### 3.2 Create CloudWatch Log Group

```bash
aws logs create-log-group --log-group-name /ecs/uhrp-storage-server
```

### 3.3 Create Task Definition

```bash
cat > task-definition.json << EOF
{
    "family": "uhrp-storage-server",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "1024",
    "memory": "2048",
    "taskRoleArn": "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/uhrp-ecs-task-role",
    "executionRoleArn": "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/uhrp-ecs-task-execution-role",
    "containerDefinitions": [
        {
            "name": "uhrp-storage",
            "image": "${ECR_URI}:latest",
            "portMappings": [
                {
                    "containerPort": 8080,
                    "protocol": "tcp"
                }
            ],
            "essential": true,
            "environment": [
                {"name": "NODE_ENV", "value": "production"},
                {"name": "AWS_BUCKET_NAME", "value": "${BUCKET_NAME}"},
                {"name": "AWS_REGION", "value": "${AWS_REGION}"},
                {"name": "HTTP_PORT", "value": "3104"},
                {"name": "CORS_ORIGIN", "value": "*"},
                {"name": "SERVER_URL", "value": "https://your-domain.com"},
                {"name": "PER_BYTE_PRICE", "value": "0.00001"},
                {"name": "BASE_PRICE", "value": "1000"},
                {"name": "SERVER_PRIVATE_KEY", "value": "YOUR_PRIVATE_KEY"},
                {"name": "BSV_NETWORK", "value": "mainnet"},
                {"name": "BUGSNAG_API_KEY", "value": "YOUR_BUGSNAG_KEY"}
            ],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "/ecs/uhrp-storage-server",
                    "awslogs-region": "${AWS_REGION}",
                    "awslogs-stream-prefix": "ecs"
                }
            },
            "healthCheck": {
                "command": ["CMD-SHELL", "curl -f http://localhost:8080/ || exit 1"],
                "interval": 30,
                "timeout": 5,
                "retries": 3,
                "startPeriod": 60
            }
        }
    ]
}
EOF

# Register task definition
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

### 3.4 Create Security Group

```bash
# Create security group for ECS tasks
aws ec2 create-security-group \
    --group-name uhrp-ecs-sg \
    --description "Security group for UHRP ECS tasks" \
    --vpc-id $VPC_ID \
    --query 'GroupId' --output text
export SG_ID=<output-from-above>

# Allow inbound HTTP traffic from ALB
aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 8080 \
    --source-group $ALB_SG_ID  # Create ALB security group first

# Allow all outbound traffic
aws ec2 authorize-security-group-egress \
    --group-id $SG_ID \
    --protocol -1 \
    --cidr 0.0.0.0/0
```

## Phase 4: Load Balancer Setup

### 4.1 Create ALB Security Group

```bash
# Create security group for ALB
aws ec2 create-security-group \
    --group-name uhrp-alb-sg \
    --description "Security group for UHRP ALB" \
    --vpc-id $VPC_ID \
    --query 'GroupId' --output text
export ALB_SG_ID=<output-from-above>

# Allow HTTPS inbound
aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp \
    --port 443 \
    --cidr 0.0.0.0/0

# Allow HTTP inbound (for redirect)
aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp \
    --port 80 \
    --cidr 0.0.0.0/0
```

### 4.2 Request SSL Certificate

```bash
# Request certificate from ACM
aws acm request-certificate \
    --domain-name your-domain.com \
    --validation-method DNS \
    --region $AWS_REGION
# Follow the DNS validation process
```

### 4.3 Create Application Load Balancer

```bash
# Create ALB
aws elbv2 create-load-balancer \
    --name uhrp-alb \
    --subnets $SUBNET_1 $SUBNET_2 \
    --security-groups $ALB_SG_ID \
    --scheme internet-facing \
    --type application \
    --ip-address-type ipv4
export ALB_ARN=<LoadBalancerArn-from-output>

# Create target group
aws elbv2 create-target-group \
    --name uhrp-targets \
    --protocol HTTP \
    --port 8080 \
    --vpc-id $VPC_ID \
    --target-type ip \
    --health-check-path / \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3
export TG_ARN=<TargetGroupArn-from-output>

# Create HTTPS listener
aws elbv2 create-listener \
    --load-balancer-arn $ALB_ARN \
    --protocol HTTPS \
    --port 443 \
    --certificates CertificateArn=<your-acm-cert-arn> \
    --default-actions Type=forward,TargetGroupArn=$TG_ARN

# Create HTTP to HTTPS redirect
aws elbv2 create-listener \
    --load-balancer-arn $ALB_ARN \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
```

### 4.4 Create ECS Service

```bash
# Create service
aws ecs create-service \
    --cluster uhrp-cluster \
    --service-name uhrp-storage-service \
    --task-definition uhrp-storage-server:1 \
    --desired-count 2 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_1,$SUBNET_2],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers targetGroupArn=$TG_ARN,containerName=uhrp-storage,containerPort=8080
```

## Phase 5: Lambda Function Setup

### 5.1 Package Lambda Function

```bash
cd notifier
npm install
zip -r ../notifier.zip .
cd ..
```

### 5.2 Create Lambda Function

```bash
# Create the function
aws lambda create-function \
    --function-name uhrp-notifier \
    --runtime nodejs18.x \
    --role arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/uhrp-lambda-execution-role \
    --handler index.notifier \
    --zip-file fileb://notifier.zip \
    --timeout 540 \
    --memory-size 4096 \
    --environment Variables='{
        NODE_ENV=production,
        SERVER_PRIVATE_KEY=YOUR_PRIVATE_KEY,
        BSV_NETWORK=mainnet
    }'

# Add S3 trigger permission
aws lambda add-permission \
    --function-name uhrp-notifier \
    --statement-id s3-trigger \
    --action lambda:InvokeFunction \
    --principal s3.amazonaws.com \
    --source-arn arn:aws:s3:::${BUCKET_NAME}
```

### 5.3 Configure S3 Event Notification

```bash
# Create notification configuration
cat > notification.json << EOF
{
    "LambdaFunctionConfigurations": [
        {
            "LambdaFunctionArn": "arn:aws:lambda:${AWS_REGION}:$(aws sts get-caller-identity --query Account --output text):function:uhrp-notifier",
            "Events": ["s3:ObjectCreated:*"]
        }
    ]
}
EOF

# Apply to bucket
aws s3api put-bucket-notification-configuration \
    --bucket $BUCKET_NAME \
    --notification-configuration file://notification.json
```

## Phase 6: GitHub Actions Configuration

### 6.1 Add GitHub Secrets

Add these secrets to your GitHub repository (Settings > Secrets and variables > Actions):

- `AWS_ACCESS_KEY_ID` - From IAM user creation
- `AWS_SECRET_ACCESS_KEY` - From IAM user creation
- `AWS_REGION` - Your chosen region
- `ECR_REPOSITORY` - uhrp-storage-server
- `ECS_CLUSTER` - uhrp-cluster
- `ECS_SERVICE` - uhrp-storage-service
- `TASK_DEFINITION_FAMILY` - uhrp-storage-server

### 6.2 Create GitHub Actions Workflow

Create `.github/workflows/deploy-aws.yaml`:

```yaml
name: Deploy to AWS
on:
  push:
    branches: [master, production]

env:
  AWS_REGION: ${{ secrets.AWS_REGION }}
  ECR_REPOSITORY: ${{ secrets.ECR_REPOSITORY }}

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    environment: ${{ github.ref_name }}

    steps:
    - name: Checkout
      uses: actions/checkout@v3

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v2
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ${{ env.AWS_REGION }}

    - name: Login to Amazon ECR
      id: login-ecr
      uses: aws-actions/amazon-ecr-login@v1

    - name: Build, tag, and push image to Amazon ECR
      id: build-image
      env:
        ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        IMAGE_TAG: ${{ github.sha }}
      run: |
        docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
        docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
        echo "image=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT

    - name: Download task definition
      run: |
        aws ecs describe-task-definition \
          --task-definition ${{ secrets.TASK_DEFINITION_FAMILY }} \
          --query taskDefinition > task-definition.json

    - name: Fill in the new image ID in the Amazon ECS task definition
      id: task-def
      uses: aws-actions/amazon-ecs-render-task-definition@v1
      with:
        task-definition: task-definition.json
        container-name: uhrp-storage
        image: ${{ steps.build-image.outputs.image }}

    - name: Deploy Amazon ECS task definition
      uses: aws-actions/amazon-ecs-deploy-task-definition@v1
      with:
        task-definition: ${{ steps.task-def.outputs.task-definition }}
        service: ${{ secrets.ECS_SERVICE }}
        cluster: ${{ secrets.ECS_CLUSTER }}
        wait-for-service-stability: true

    - name: Update Lambda function
      run: |
        cd notifier
        npm install --production
        zip -r ../notifier.zip .
        cd ..
        aws lambda update-function-code \
          --function-name uhrp-notifier \
          --zip-file fileb://notifier.zip
```

## Phase 7: Code Modifications Required

### 7.1 Environment Variables

Update your application to use AWS-specific environment variables:

```javascript
// Old (GCP)
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

// New (AWS)
const bucketName = process.env.AWS_BUCKET_NAME;
```

### 7.2 Storage SDK

Replace Google Cloud Storage with AWS S3:

```javascript
// Install AWS SDK
// npm install @aws-sdk/client-s3

// Old (GCP)
const { Storage } = require('@google-cloud/storage');
const storage = new Storage();

// New (AWS)
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({ region: process.env.AWS_REGION });
```

### 7.3 Update File Operations

Example file upload modification:

```javascript
// Old (GCP)
async function uploadFile(file) {
  const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
  const blob = bucket.file(fileName);
  await blob.save(fileBuffer);
}

// New (AWS)
async function uploadFile(file) {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: fileName,
    Body: fileBuffer,
    ContentType: file.mimetype
  });
  await s3Client.send(command);
}
```

### 7.4 Lambda Handler

Modify the notifier for Lambda:

```javascript
// Old (GCP Cloud Function)
exports.notifier = async (file, context) => {
  // Process file
};

// New (AWS Lambda)
exports.notifier = async (event, context) => {
  // S3 event structure is different
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(event.Records[0].s3.object.key);
  // Process file
};
```

## Phase 8: Testing and Validation

### 8.1 Test S3 Operations

```bash
# Upload test file
aws s3 cp test.txt s3://$BUCKET_NAME/test.txt

# Verify Lambda triggered
aws logs tail /aws/lambda/uhrp-notifier --follow

# Download test file
aws s3 cp s3://$BUCKET_NAME/test.txt downloaded.txt
```

### 8.2 Test ECS Service

```bash
# Check service status
aws ecs describe-services \
    --cluster uhrp-cluster \
    --services uhrp-storage-service

# View logs
aws logs tail /ecs/uhrp-storage-server --follow

# Test endpoint
curl https://your-domain.com/
```

### 8.3 Load Testing

```bash
# Install artillery
npm install -g artillery

# Create test script
cat > load-test.yml << EOF
config:
  target: "https://your-domain.com"
  phases:
    - duration: 60
      arrivalRate: 10
scenarios:
  - name: "Upload Test"
    flow:
      - post:
          url: "/upload"
          headers:
            Authorization: "Bearer YOUR_TOKEN"
          formData:
            file: "./test-file.pdf"
EOF

# Run load test
artillery run load-test.yml
```

## Phase 9: Monitoring and Maintenance

### 9.1 CloudWatch Alarms

```bash
# Create CPU alarm
aws cloudwatch put-metric-alarm \
    --alarm-name uhrp-high-cpu \
    --alarm-description "Alert when CPU exceeds 80%" \
    --metric-name CPUUtilization \
    --namespace AWS/ECS \
    --statistic Average \
    --period 300 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2

# Create error rate alarm
aws cloudwatch put-metric-alarm \
    --alarm-name uhrp-high-error-rate \
    --alarm-description "Alert when 5xx errors exceed 10%" \
    --metric-name HTTPCode_Target_5XX_Count \
    --namespace AWS/ApplicationELB \
    --statistic Sum \
    --period 300 \
    --threshold 10 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1
```

### 9.2 Auto Scaling

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id service/uhrp-cluster/uhrp-storage-service \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity 2 \
    --max-capacity 10

# Create scaling policy
aws application-autoscaling put-scaling-policy \
    --policy-name uhrp-cpu-scaling \
    --service-namespace ecs \
    --resource-id service/uhrp-cluster/uhrp-storage-service \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration '{
        "TargetValue": 70.0,
        "PredefinedMetricSpecification": {
            "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
        }
    }'
```

## Troubleshooting

### Common Issues

1. **ECS tasks failing to start**
   - Check CloudWatch logs
   - Verify IAM roles have correct permissions
   - Ensure security groups allow traffic

2. **Lambda not triggering**
   - Verify S3 event configuration
   - Check Lambda permissions
   - Review CloudWatch logs

3. **ALB health checks failing**
   - Verify container health check
   - Check security group rules
   - Ensure application responds on health check path

4. **S3 access denied**
   - Review IAM policies
   - Check bucket policies
   - Verify CORS configuration

### Useful Commands

```bash
# View ECS task logs
aws logs get-log-events \
    --log-group-name /ecs/uhrp-storage-server \
    --log-stream-name ecs/uhrp-storage/<task-id>

# Force new deployment
aws ecs update-service \
    --cluster uhrp-cluster \
    --service uhrp-storage-service \
    --force-new-deployment

# Check ALB target health
aws elbv2 describe-target-health \
    --target-group-arn $TG_ARN
```

## Cost Optimization

1. **Use S3 Intelligent-Tiering** for automatic storage class transitions
2. **Enable ECS Fargate Spot** for non-critical workloads
3. **Set up S3 lifecycle policies** to delete old files
4. **Use CloudFront** for static content delivery
5. **Right-size ECS tasks** based on actual usage

## Security Best Practices

1. **Use AWS Secrets Manager** for sensitive environment variables
2. **Enable VPC endpoints** for S3 access
3. **Implement AWS WAF** on the ALB
4. **Use private subnets** for ECS tasks
5. **Enable S3 bucket encryption**
6. **Set up AWS GuardDuty** for threat detection
7. **Use least-privilege IAM policies**

## Next Steps

1. Set up CloudFront distribution for CDN
2. Implement AWS Backup for S3 data
3. Configure AWS X-Ray for distributed tracing
4. Set up AWS Cost Explorer budgets
5. Implement multi-region deployment for high availability

---

© 2025 - UHRP Storage Server AWS Deployment Guide