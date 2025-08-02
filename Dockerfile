# Base image with Python
FROM python:3.11-slim

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies including Tesseract OCR and required libs
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libglib2.0-0 \
        libsm6 \
        libxrender1 \
        libxext6 \
        curl \
        build-essential && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first (cache layer)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# ✅ Copy entire project including templates and static files
COPY . .

# ✅ Debug step: list templates folder to confirm it's copied
RUN echo ">>> Checking templates folder:" && ls -R /app/templates || echo "Templates folder missing!"

# Expose the port Render uses
EXPOSE 10000

# Start the Flask app using gunicorn
CMD ["gunicorn", "-b", "0.0.0.0:10000", "api:app"]
