FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-heb \
    tesseract-ocr-eng \
    ghostscript \
    unpaper \
    pngquant \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
