FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p data/uploads

ENV NODE_ENV=production
ENV PORT=8858

EXPOSE 8858

CMD ["node", "server.js"]
