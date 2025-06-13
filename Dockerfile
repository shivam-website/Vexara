# Base image with Python
FROM python:3.11-slim

# Install system dependencies including Tesseract
RUN apt-get update && \
    apt-get install -y tesseract-ocr libglib2.0-0 libsm6 libxrender1 libxext6 && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Expose the port Render uses
EXPOSE 10000

# Start the Flask app using gunicorn
CMD ["gunicorn", "-b", "0.0.0.0:10000", "app:app"]
