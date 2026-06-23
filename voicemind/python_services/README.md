# VoiceMind Python Services

Microservices for transcription and Q&A using local AI models.

## Services

### 1. Transcription Service (Port 8001)

Speech-to-text using faster-whisper (optimized Whisper implementation).

**Setup:**
```bash
cd transcription_service
pip install -r requirements.txt
python main.py
```

**Models:**
- `tiny` - Fastest, lowest accuracy
- `base` - Fast, good accuracy
- `small` - Balanced (recommended)
- `medium` - Better accuracy, slower
- `large-v3` - Best accuracy, slowest

**Environment:**
```env
PORT=8001
WHISPER_MODEL=small
WHISPER_DEVICE=cpu  # or cuda
WHISPER_COMPUTE=int8  # or float16
```

**Endpoints:**
- `GET /health` - Health check
- `POST /transcribe` - Transcribe audio file
- `POST /transcribe-upload` - Transcribe uploaded file

### 2. Q&A Service (Port 8002)

Question answering using Ollama (local LLM).

**Setup:**
```bash
# Install Ollama first
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.2:latest

# Start Ollama
ollama serve

# In another terminal:
cd qa_service
pip install -r requirements.txt
python main.py
```

**Environment:**
```env
PORT=8002
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
```

**Endpoints:**
- `GET /health` - Health check
- `POST /qa` - Answer question
- `POST /summarize` - Summarize text

## Docker (Optional)

```dockerfile
# Transcription
FROM python:3.9
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .
CMD ["python", "main.py"]
```

## Performance Notes

- **faster-whisper**: Uses int8 quantization for CPU, much faster than original Whisper
- **Ollama**: Runs models locally, no API keys needed
- For GPU: Install CUDA and PyTorch with CUDA support
