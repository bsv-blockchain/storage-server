FROM node:23-alpine

# Create app directory
WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 -S nodejs && \
    adduser -S nodejs -u 1000 -G nodejs

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8081

# Start the event handler
CMD ["node", "src/event-handler.js"]