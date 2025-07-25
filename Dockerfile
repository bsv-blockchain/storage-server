FROM node:23-alpine

EXPOSE 8080
WORKDIR /app
COPY package.json .
RUN npm i
COPY . .
RUN npm run build
CMD [ "npm", "start"]
