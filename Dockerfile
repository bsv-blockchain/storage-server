FROM node:22-alpine

EXPOSE 8080
WORKDIR /app
COPY package.json .
RUN npm ci --omit=dev
COPY . .
RUN npm run build
CMD [ "npm", "start"]
