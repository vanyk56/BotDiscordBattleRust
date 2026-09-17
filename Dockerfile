FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
RUN grep -q "setup-ideas" src/index.js && grep -q "setup-rules" src/index.js && grep -q "setup-wipe" src/index.js && grep -q "setup-info" src/index.js

ENV NODE_ENV=production
ENV BOT_BUILD=1.5.0
EXPOSE 3000
CMD ["npm", "start"]
