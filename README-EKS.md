# UHRP Storage Server – EKS Deployment Guide

This guide walks you through deploying the **UHRP Storage Server** on Amazon Elastic Kubernetes Service (EKS). This approach consolidates all components into a single Kubernetes cluster, eliminating the need for separate ECS and Lambda services.

## Architecture Overview

In this EKS deployment:
- **Storage Server** runs as a Kubernetes Deployment
- **S3 Event Handler** replaces Lambda, running as a pod in the cluster
- **AWS ALB Ingress Controller** handles HTTPS termination
- **S3 Bucket** remains the only external AWS service
- **Everything else** runs inside Kubernetes

## Benefits Over ECS/Lambda

1. **Unified Platform** - All components in one cluster
2. **Simplified Deployment** - Single kubectl/helm command
3. **Better Resource Utilization** - Pod packing and node sharing
4. **Native Scaling** - Kubernetes HPA instead of AWS-specific scaling
5. **Portable** - Can run on any Kubernetes cluster (not just EKS)

## Prerequisites

- AWS Account with appropriate permissions
- `kubectl` CLI installed
- `eksctl` CLI installed
- `helm` v3 installed
- AWS CLI configured
- Docker installed (for local builds)

## Phase 1: EKS Cluster Setup

### 1.1 Create EKS Cluster

```bash
# Set your configuration
export AWS_REGION=us-west-2
export CLUSTER_NAME=uhrp-cluster
export NODE_GROUP_NAME=uhrp-nodes

# Create cluster with eksctl
eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --nodegroup-name $NODE_GROUP_NAME \
  --node-type t3.medium \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 5 \
  --managed \
  --with-oidc \
  --ssh-access \
  --ssh-public-key ~/.ssh/id_rsa.pub

# Verify cluster is ready
kubectl get nodes
```

### 1.2 Install AWS Load Balancer Controller

The AWS Load Balancer Controller manages ALBs for Kubernetes Ingress resources.

```bash
# Download IAM policy
curl -o iam_policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.6.2/docs/install/iam_policy.json

# Create IAM policy
aws iam create-policy \
    --policy-name AWSLoadBalancerControllerIAMPolicy \
    --policy-document file://iam_policy.json

# Create service account
eksctl create iamserviceaccount \
  --cluster=$CLUSTER_NAME \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --attach-policy-arn=arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/AWSLoadBalancerControllerIAMPolicy \
  --override-existing-serviceaccounts \
  --approve

# Install using Helm
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=$CLUSTER_NAME \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

### 1.3 Install EBS CSI Driver (for persistent volumes)

```bash
# Create IAM role for EBS CSI driver
eksctl create iamserviceaccount \
  --cluster=$CLUSTER_NAME \
  --namespace=kube-system \
  --name=ebs-csi-controller-sa \
  --attach-policy-arn=arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --override-existing-serviceaccounts \
  --approve

# Install EBS CSI driver
kubectl apply -k "github.com/kubernetes-sigs/aws-ebs-csi-driver/deploy/kubernetes/overlays/stable/ecr/?ref=release-1.24"
```

## Phase 2: S3 Setup and Event Configuration

### 2.1 Create S3 Bucket

```bash
export BUCKET_NAME=uhrp-storage-$(date +%s)

# Create bucket
aws s3api create-bucket \
    --bucket $BUCKET_NAME \
    --region $AWS_REGION \
    --create-bucket-configuration LocationConstraint=$AWS_REGION

# Apply CORS configuration
aws s3api put-bucket-cors \
    --bucket $BUCKET_NAME \
    --cors-configuration file://aws/s3-cors.json
```

### 2.2 Create SQS Queue for S3 Events

Since Lambda is being replaced, we'll use SQS to queue S3 events for processing by our Kubernetes pods.

```bash
# Create SQS queue
aws sqs create-queue \
    --queue-name uhrp-s3-events \
    --region $AWS_REGION

# Get queue URL and ARN
QUEUE_URL=$(aws sqs get-queue-url --queue-name uhrp-s3-events --query QueueUrl --output text --region $AWS_REGION)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names QueueArn --query Attributes.QueueArn --output text --region $AWS_REGION)

# Create SQS policy to allow S3 to send messages
cat > sqs-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "s3.amazonaws.com"
      },
      "Action": "sqs:SendMessage",
      "Resource": "${QUEUE_ARN}",
      "Condition": {
        "ArnLike": {
          "aws:SourceArn": "arn:aws:s3:::${BUCKET_NAME}"
        }
      }
    }
  ]
}
EOF

# Set the SQS queue policy
aws sqs set-queue-attributes \
    --queue-url $QUEUE_URL \
    --region $AWS_REGION \
    --attributes Policy="$(cat sqs-policy.json | jq -c . | sed 's/"/\\"/g')"

# Create S3 event notification configuration
cat > s3-notification.json << EOF
{
    "QueueConfigurations": [
        {
            "QueueArn": "${QUEUE_ARN}",
            "Events": ["s3:ObjectCreated:*"],
            "Filter": {
                "Key": {
                    "FilterRules": [
                        {
                            "Name": "prefix",
                            "Value": "cdn/"
                        }
                    ]
                }
            }
        }
    ]
}
EOF

# Configure S3 to send events to SQS
aws s3api put-bucket-notification-configuration \
    --bucket $BUCKET_NAME \
    --notification-configuration file://s3-notification.json
```

## Phase 3: IAM Roles for Service Accounts (IRSA)

### 3.1 Create IAM Policy for Storage Server

```bash
cat > storage-server-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket",
                "s3:GetObjectMetadata",
                "s3:PutObjectMetadata"
            ],
            "Resource": [
                "arn:aws:s3:::${BUCKET_NAME}",
                "arn:aws:s3:::${BUCKET_NAME}/*"
            ]
        }
    ]
}
EOF

aws iam create-policy \
    --policy-name uhrp-storage-server-policy \
    --policy-document file://storage-server-policy.json
```

### 3.2 Create IAM Policy for S3 Event Handler

```bash
cat > event-handler-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes"
            ],
            "Resource": "${QUEUE_ARN}"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:GetObjectMetadata"
            ],
            "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
        }
    ]
}
EOF

aws iam create-policy \
    --policy-name uhrp-event-handler-policy \
    --policy-document file://event-handler-policy.json
```

### 3.3 Create Kubernetes Service Accounts with IRSA

```bash
# Create namespace
kubectl create namespace uhrp-storage

# Create service account for storage server
eksctl create iamserviceaccount \
    --cluster=$CLUSTER_NAME \
    --namespace=uhrp-storage \
    --name=storage-server \
    --attach-policy-arn=arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/uhrp-storage-server-policy \
    --override-existing-serviceaccounts \
    --approve

# Create service account for event handler
eksctl create iamserviceaccount \
    --cluster=$CLUSTER_NAME \
    --namespace=uhrp-storage \
    --name=event-handler \
    --attach-policy-arn=arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/uhrp-event-handler-policy \
    --override-existing-serviceaccounts \
    --approve
```

## Phase 4: Deploy Application

### 4.1 Create ConfigMap

```bash
kubectl apply -f k8s/configmap.yaml
```

### 4.2 Create Secrets

```bash
# Create secret from environment variables
kubectl create secret generic uhrp-secrets \
    --namespace=uhrp-storage \
    --from-literal=server-private-key=$SERVER_PRIVATE_KEY \
    --from-literal=admin-token=$ADMIN_TOKEN \
    --from-literal=bugsnag-api-key=$BUGSNAG_API_KEY
```

### 4.3 Deploy Storage Server

```bash
# Apply all manifests
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
```

### 4.4 Deploy S3 Event Handler

```bash
kubectl apply -f k8s/s3-event-handler/deployment.yaml
```

### 4.5 Verify Deployment

```bash
# Check pods are running
kubectl get pods -n uhrp-storage

# Check services
kubectl get svc -n uhrp-storage

# Check ingress (wait for ADDRESS to be populated)
kubectl get ingress -n uhrp-storage

# Get logs
kubectl logs -n uhrp-storage -l app=storage-server --tail=100
```

## Phase 5: DNS Configuration

Once the Ingress has an ADDRESS:

```bash
# Get the ALB DNS name
ALB_DNS=$(kubectl get ingress -n uhrp-storage storage-server-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

echo "Create a CNAME record pointing your domain to: $ALB_DNS"
```

## Phase 6: Monitoring and Observability

### 6.1 Install Prometheus and Grafana

```bash
# Add Prometheus Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install kube-prometheus-stack
helm install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
    --set grafana.adminPassword=admin
```

### 6.2 Install Fluentd for Log Aggregation

```bash
kubectl apply -f k8s/monitoring/fluentd-daemonset.yaml
```

### 6.3 Access Grafana

```bash
# Port forward to access Grafana
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80

# Access at http://localhost:3000
# Username: admin
# Password: admin
```

## Phase 7: CI/CD with GitHub Actions

Configure GitHub secrets:
- `AWS_REGION`
- `EKS_CLUSTER_NAME`
- `ECR_REPOSITORY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Then push to trigger deployment:

```bash
git add .
git commit -m "Deploy to EKS"
git push origin master
```

## Operational Commands

### Scaling

```bash
# Manual scaling
kubectl scale deployment storage-server -n uhrp-storage --replicas=5

# Check HPA status
kubectl get hpa -n uhrp-storage
```

### Updates

```bash
# Update deployment
kubectl set image deployment/storage-server storage-server=your-ecr-url:new-tag -n uhrp-storage

# Rolling restart
kubectl rollout restart deployment/storage-server -n uhrp-storage

# Check rollout status
kubectl rollout status deployment/storage-server -n uhrp-storage
```

### Debugging

```bash
# Get pod logs
kubectl logs -n uhrp-storage -l app=storage-server -f

# Exec into pod
kubectl exec -it -n uhrp-storage deployment/storage-server -- /bin/sh

# Describe pod for events
kubectl describe pod -n uhrp-storage <pod-name>

# Get events
kubectl get events -n uhrp-storage --sort-by='.lastTimestamp'
```

## Cost Optimization

1. **Use Spot Instances** for worker nodes:
```bash
eksctl create nodegroup \
    --cluster=$CLUSTER_NAME \
    --name=spot-nodes \
    --spot \
    --instance-types=t3.medium,t3a.medium \
    --nodes-min=2 \
    --nodes-max=10
```

2. **Enable Cluster Autoscaler**:
```bash
kubectl apply -f k8s/cluster-autoscaler.yaml
```

3. **Use Karpenter** for more efficient node provisioning
4. **Set resource requests/limits** appropriately
5. **Use S3 Lifecycle policies** for old files

## Security Best Practices

1. **Network Policies** - Restrict pod-to-pod communication
2. **Pod Security Standards** - Enforce security policies
3. **Secrets Management** - Use AWS Secrets Manager with Secrets Store CSI Driver
4. **Image Scanning** - Enable ECR image scanning
5. **RBAC** - Implement least-privilege access
6. **Audit Logging** - Enable EKS audit logs

## Troubleshooting

### Common Issues

1. **Ingress not getting ADDRESS**
   - Check AWS Load Balancer Controller logs
   - Verify IAM permissions

2. **Pods can't access S3**
   - Check IRSA configuration
   - Verify service account annotations

3. **S3 events not processing**
   - Check SQS queue for messages
   - Verify event handler logs

4. **High memory usage**
   - Adjust resource limits
   - Check for memory leaks

## Migration from ECS/Lambda

To migrate existing data:

1. Stop ECS services
2. Deploy to EKS
3. Update DNS to point to new ALB
4. Monitor for issues
5. Decommission old infrastructure

## Next Steps

1. Implement GitOps with ArgoCD
2. Add service mesh (Istio/Linkerd)
3. Implement progressive delivery
4. Add chaos engineering tests
5. Implement multi-region deployment

---

© 2025 - UHRP Storage Server EKS Deployment Guide
