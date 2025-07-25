FROM node:23-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies as root (for proper permissions)
RUN npm install --omit=dev

# Copy application code with correct ownership
COPY --chown=node:node . .

# Switch to non-root user
USER node

# Expose port
EXPOSE 8081

# Start the event handler
CMD ["node", "src/event-handler.js"]