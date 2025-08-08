import json
import base64
import requests
import time
import uuid
import os
from flask import Flask, render_template, request, jsonify, redirect, session, url_for, make_response
from flask_dance.contrib.google import make_google_blueprint, google
from authlib.integrations.flask_client import OAuth
from PIL import Image
import pytesseract  # Assuming tesseract is installed and configured
import tempfile
from datetime import datetime, date, timedelta
from flask_cors import CORS   # ✅ NEW IMPORT

# --- REMOVED IMPORTS FOR LOCAL IMAGE GENERATION ---
# import torch
# from diffusers import StableDiffusionPipeline
# --- END REMOVED IMPORTS ---

# Fixed: Handle __app_id__ not being defined when running outside Canvas
app_name = '__main__'
if '__app_id__' in globals():
    app_name = globals()['__app_id__']
app_root = os.path.dirname(os.path.abspath(__file_))
template_folder = os.path.join(app_root, "templates")
app = Flask(app_name, template_folder=template_folder) # Using the det

# ✅ Enable CORS (Allowing frontend calls from any domain for now)
CORS(app, resources={r"/*": {"origins": "*"}})

# Use an environment variable for the secret key for better security
app.secret_key = os.environ.get("FLASK_SECRET_KEY", str(uuid.uuid4()))

# --- API KEYS ---
# IMPORTANT: For production, load these from secure environment variables!
# Example: os.environ.get("GOOGLE_GEMINI_API_KEY")
GOOGLE_GEMINI_API_KEY = os.environ.get("GOOGLE_GEMINI_API_KEY", "") # Your Google Gemini API Key
AWAN_API_KEY = os.environ.get("AWAN_API_KEY", "21f7fbb7-1209-4039-a7cc-dd0a6de383c3") # Your Awan API Key
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "") # Your Groq API Key
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "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") # Your OpenRouter API Key
SERPER_API_KEY = os.environ.get("SERPER_API_KEY", "bb48b607349e5e050312a72459a8886e24a0edbc") # Your Serper API Key

# --- API Endpoints and Models ---
# Changed Gemini API URL to use gemini-2.0-flash
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
# Removed GEMINI_VISION_API_URL as only pytesseract will be used for image vision
AWAN_API_URL = "https://api.awanllm.com/v1/chat/completions"
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Preferred models for each API (can be adjusted)
# Changed Gemini model to gemini-2.0-flash
GEMINI_MODEL = "gemini-2.0-flash"
AWAN_MODEL = "Meta-Llama-3-8B-Instruct"
GROQ_MODEL = "llama3-8b-8192" # Or "mixtral-8x7b-32768"
OPENROUTER_GENERAL_MODEL = "mistralai/mistral-small-3.2-24b-instruct:free" # Changed from ministral-8b
OPENROUTER_DEEPTHINK_MODEL = "deepseek/deepseek-r1-0528:free"

# Directory for storing chat history files
CHAT_HISTORY_DIR = os.path.join(app.root_path, 'chat_history')
os.makedirs(CHAT_HISTORY_DIR, exist_ok=True)
# Directory for storing uploaded images
UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- REMOVED LOCAL IMAGE GENERATION SETUP ---
# pipe = None # Initialize pipe to None
# if torch.cuda.is_available():
#     try:
#         pipe = StableDiffusionPipeline.from_pretrained(
#             "SG161222/Realistic_Vision_V4.0",
#             torch_dtype=torch.float16
#         ).to(device)
#         pipe.enable_attention_slicing()
#         pipe.enable_vae_slicing()
#         print("Stable Diffusion model loaded successfully on GPU.")
#     except Exception as e:
#         error_message = (
#             f"Error loading Stable Diffusion model on GPU: {e}. "
#             "This might indicate insufficient GPU VRAM, corrupted model files, "
#             "or a deeper PyTorch/CUDA configuration issue."
#         )
#         print(error_message)
# else:
#     print("Warning: CUDA GPU not found. Local image generation will be disabled.")
# --- END REMOVED LOCAL IMAGE GENERATION SETUP ---


# Tesseract OCR configuration (uncomment and modify for your OS if needed)
# You need to install Tesseract OCR separately on your system for this to work.
# Windows: pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
# macOS (with Homebrew): pytesseract.pytesseract.tesseract_cmd = '/opt/homebrew/bin/tesseract' or '/usr/local/bin/tesseract'
# Linux: pytesseract.pytesseract.tesseract_cmd = '/usr/bin/tesseract'
# pytesseract.pytesseract.tesseract_cmd = r'/path/to/your/tesseract_executable'

# --- QUOTA TRACKING ---
# In-memory dictionary to store daily message counts per user.
# Format: {user_id: {date_str: count}}
user_message_counts = {}
DAILY_MESSAGE_LIMIT = 20 # Daily message quota per user

def get_daily_message_count(user_id):
    """Retrieves the message count for the current user and day."""
    today_str = date.today().isoformat()
    # Initialize user's entry if it doesn't exist
    if user_id not in user_message_counts:
        user_message_counts[user_id] = {}
    # Initialize today's count if it doesn't exist
    if today_str not in user_message_counts[user_id]:
        user_message_counts[user_id][today_str] = 0
    return user_message_counts[user_id][today_str]

def increment_daily_message_count(user_id):
    """Increments the message count for the current user and day."""
    today_str = date.today().isoformat()
    if user_id not in user_message_counts:
        user_message_counts[user_id] = {}
    if today_str not in user_message_counts[user_id]:
        user_message_counts[user_id][today_str] = 0
    user_message_counts[user_id][today_str] += 1
    # Clean up old dates to prevent memory growth (e.g., keep only last 7 days)
    # This is a simple cleanup; for production, a more robust solution (like Redis expiration) is better.
    one_week_ago = (date.today() - timedelta(days=7)).isoformat()
    for d_str in list(user_message_counts[user_id].keys()):
        if d_str < one_week_ago:
            del user_message_counts[user_id][d_str]

# --- CACHE LAYER ---
# In-memory cache for recent Q&A pairs.
# Format: {(user_id, instruction_hash): response_text}
# Using a simple dictionary. For production, consider LRU cache or Redis.
cache = {}
CACHE_MAX_SIZE = 1000 # Max number of items in cache

def get_from_cache(user_id, instruction):
    """Retrieves a response from the cache if available."""
    # Create a simple hash for the instruction to use as part of the key
    instruction_hash = hash(instruction)
    key = (user_id, instruction_hash)
    return cache.get(key)

def add_to_cache(user_id, instruction, response):
    """Adds a Q&A pair to the cache."""
    instruction_hash = hash(instruction)
    key = (user_id, instruction_hash)
    # Simple cache eviction: if cache exceeds max size, remove the oldest item
    if len(cache) >= CACHE_MAX_SIZE:
        # This is a very basic eviction (arbitrary item removal);
        # a real LRU cache would track access times.
        first_key = next(iter(cache))
        del cache[first_key]
    cache[key] = response

# OAuth configuration
google_bp = make_google_blueprint(
    client_id="978102306464-qdjll3uos10m1nd5gcnr9iql9688db58.apps.googleusercontent.com",
    client_secret="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", # Ensure this is your actual client secret
    redirect_url="/google_login/authorized",
    scope=["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]
)
app.register_blueprint(google_bp, url_prefix="/google_login")

oauth = OAuth(app)
microsoft = oauth.register(
    name='microsoft',
    client_id="your_microsoft_client_id",   # IMPORTANT: Replace with your Microsoft client ID
    client_secret="your_microsoft_client_secret",   # IMPORTANT: Replace with your Microsoft client secret
    access_token_url='https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authorize_url='https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    api_base_url='https://graph.microsoft.com/v1.0/',
    client_kwargs={'scope': 'User.Read'}
)

# --- Chat History Management Functions ---
def get_user_id():
    """
    Gets a unique user ID. Prefers authenticated user ID.
    If not authenticated, generates a temporary session-based ID.
    """
    if 'user_id' in session:
        return session['user_id']
    
    if 'temp_user_id' not in session:
        session['temp_user_id'] = str(uuid.uuid4())
        session['user_id'] = session['temp_user_id']
    return session['temp_user_id']

def get_chat_file_path(user_id, chat_id):
    """Constructs the file path for a specific chat history."""
    safe_user_id = "".join(c for c in user_id if c.isalnum() or c in ('-', '_')).strip()
    return os.path.join(CHAT_HISTORY_DIR, f"{safe_user_id}_{chat_id}.json")

def load_chat_history_from_file(user_id, chat_id):
    """Loads chat history for a given user and chat ID from a JSON file.
    Improved error handling from app.py.
    """
    file_path = get_chat_file_path(user_id, chat_id)
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"Warning: Could not decode JSON from {file_path}. Starting with empty chat.")
            return []
        except Exception as e:
            print(f"Error loading chat history from {file_path}: {e}")
            return []
    return []

def save_chat_history_to_file(user_id, chat_id, chat_data):
    """Saves chat history for a given user and chat ID to a JSON file."""
    file_path = get_chat_file_path(user_id, chat_id)
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(chat_data, f, indent=4)
    except IOError as e:
        print(f"Error saving chat history to {file_path}: {e}")

# --- Web Search Function ---
def perform_web_search(query):
    """Performs a web search using the Serper.dev API and returns the top results.
    Includes robust error handling and structured output.
    (Adopted from app.py with minor adjustments for logging)
    """
    if not SERPER_API_KEY:
        return "❌ Web search API key (SERPER_API_KEY) is not configured."

    if not query.strip():
        return "❓ Please provide a query to perform a web search."

    try:
        response = requests.post(
            "https://google.serper.dev/search",
            headers={
                "X-API-KEY": SERPER_API_KEY,
                "Content-Type": "application/json"
            },
            json={"q": query}
        )

        print(f"DEBUG: Serper API Response Status Code: {response.status_code}")

        response.raise_for_status()  # Raises HTTPError for bad responses (4xx or 5xx)

        try:
            data = response.json()
        except json.JSONDecodeError as e:
            print("DEBUG: JSONDecodeError caught. Raw response content (first 500 chars):")
            print(response.text[:500])
            if "<!doctype html>" in response.text.lower() or "<html" in response.text.lower():
                return f"❌ Web search failed: Received HTML instead of JSON. This often indicates an invalid API key, rate limit, or an issue with the Serper API itself. Raw response starts with: {response.text[:100]}..."
            return f"❌ Web search API returned invalid data: {e}. Raw response starts with: {response.text[:100]}..."

        if data.get("error"):
            return f"❌ Serper API Error: {data['error']}"

        if "organic" not in data or not data["organic"]:
            return "😕 No relevant search results found."

        results = []
        for i, item in enumerate(data["organic"][:3]):
            title = item.get("title", "No Title")
            snippet = item.get("snippet", "No snippet available.")
            link = item.get("link", "#")

            results.append(f"{i+1}. **{title}**\n{snippet}\n🔗 {link}")

        return "🔎 Here's what I found:\n\n" + "\n\n---\n\n".join(results)

    except requests.exceptions.HTTPError as e:
        error_message = f"❌ Web search network error: HTTP {response.status_code}"
        if response.status_code == 401:
            error_message += " - Unauthorized. Invalid API Key or authentication error. Please check your SERPER_API_KEY."
        elif response.status_code == 429:
            error_message += " - Too Many Requests (Rate Limit). Please wait a moment and try again."
        else:
            error_message += f" - {e}"
        print(f"DEBUG: HTTPError caught. Raw response content (first 500 chars):")
        print(response.text[:500])
        return error_message

    except requests.exceptions.ConnectionError as e:
        return f"❌ Web search failed: Could not connect to the API server. Please check your internet connection."

    except requests.exceptions.Timeout as e:
        return f"⏳ Web search failed: The request timed out. The API server might be busy."

    except requests.exceptions.RequestException as e:
        return f"❌ A general request error occurred during web search: {e}"

    except Exception as e:
        return f"🚨 An unexpected error occurred during web search: {e}"

# --- AI Model Interaction Functions with Fallback ---

def call_gemini_api(messages, model_name=GEMINI_MODEL):
    """Calls the Google Gemini API."""
    if not GOOGLE_GEMINI_API_KEY:
        return {"error": "Google Gemini API Key not configured."}
    
    headers = {
        "Content-Type": "application/json",
    }
    # Gemini API expects 'parts' in content, and 'role' as 'user' or 'model'
    gemini_messages = []
    for msg in messages:
        role = "user" if msg["role"] == "user" else "model"
        gemini_messages.append({"role": role, "parts": [{"text": msg["content"]}]})

    payload = {
        "contents": gemini_messages,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 1024,
            # "stream": True
        }
    }
    try:
        # Use the GEMINI_API_URL which now points to gemini-2.0-flash
        response = requests.post(f"{GEMINI_API_URL}?key={GOOGLE_GEMINI_API_KEY}", headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        json_response = response.json()
        if json_response and json_response.get('candidates') and json_response['candidates'][0].get('content') and json_response['candidates'][0]['content'].get('parts'):
            return {"text": json_response['candidates'][0]['content']['parts'][0]['text']}
        else:
            print(f"Gemini API returned unexpected structure: {json_response}")
            return {"error": "Gemini API returned unexpected response structure."}
    except requests.exceptions.HTTPError as http_err:
        print(f"Gemini API HTTP error: {http_err} - {response.text}")
        return {"error": f"Gemini API HTTP error: {response.status_code} - {response.text}"}
    except requests.exceptions.RequestException as req_err:
        print(f"Gemini API request error: {req_err}")
        return {"error": f"Gemini API request error: {req_err}"}
    except json.JSONDecodeError as json_err:
        print(f"Gemini API JSON decode error: {json_err} - Response: {response.text}")
        return {"error": "Gemini API returned invalid JSON."}
    except Exception as e:
        print(f"An unexpected error occurred during Gemini API call: {e}")
        return {"error": f"An unexpected error occurred: {e}"}

def call_awan_api(messages, model_name=AWAN_MODEL):
    """Calls the Awan LLM API."""
    if not AWAN_API_KEY:
        return {"error": "Awan API Key not configured."}

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {AWAN_API_KEY}"
    }
    payload = {
        "model": model_name,
        "messages": messages,
        "temperature": 0.7,
        # "stream": True
    }
    try:
        response = requests.post(AWAN_API_URL, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        json_response = response.json()
        if json_response and json_response.get('choices') and json_response['choices'][0].get('message'):
            return {"text": json_response['choices'][0]['message']['content']}
        else:
            print(f"Awan API returned unexpected structure: {json_response}")
            return {"error": "Awan API returned unexpected response structure."}
    except requests.exceptions.HTTPError as http_err:
        print(f"Awan API HTTP error: {http_err} - {response.text}")
        return {"error": f"Awan API HTTP error: {response.status_code} - {response.text}"}
    except requests.exceptions.RequestException as req_err:
        print(f"Awan API request error: {req_err}")
        return {"error": f"Awan API request error: {req_err}"}
    except json.JSONDecodeError as json_err:
        print(f"Awan API JSON decode error: {json_err} - Response: {response.text}")
        return {"error": "Awan API returned invalid JSON."}
    except Exception as e:
        print(f"An unexpected error occurred during Awan API call: {e}")
        return {"error": f"An unexpected error occurred: {e}"}

def call_groq_api(messages, model_name=GROQ_MODEL):
    """Calls the Groq API."""
    if not GROQ_API_KEY:
        return {"error": "Groq API Key not configured."}

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {GROQ_API_KEY}"
    }
    payload = {
        "model": model_name,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 1024,
        "stream": True
    }
    try:
        response = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        json_response = response.json()
        if json_response and json_response.get('choices') and json_response['choices'][0].get('message'):
            return {"text": json_response['choices'][0]['message']['content']}
        else:
            print(f"Groq API returned unexpected structure: {json_response}")
            return {"error": "Groq API returned unexpected response structure."}
    except requests.exceptions.HTTPError as http_err:
        print(f"Groq API HTTP error: {http_err} - {response.text}")
        return {"error": f"Groq API HTTP error: {response.status_code} - {response.text}"}
    except requests.exceptions.RequestException as req_err:
        print(f"Groq API request error: {req_err}")
        return {"error": f"Groq API request error: {req_err}"}
    except json.JSONDecodeError as json_err:
        print(f"Groq API JSON decode error: {json_err} - Response: {response.text}")
        return {"error": "Groq API returned invalid JSON."}
    except Exception as e:
        print(f"An unexpected error occurred during Groq API call: {e}")
        return {"error": f"An unexpected error occurred: {e}"}

def call_openrouter_api(messages, model_name):
    """Calls the OpenRouter API with a list of messages using the specified model."""
    if not OPENROUTER_API_KEY:
        return {"error": "OpenRouter API Key not configured."}

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {OPENROUTER_API_KEY}"
    }
    payload = {
        "model": model_name,
        "messages": messages,
        "temperature": 0.7,
        "top_p": 1,
        "max_tokens": 1024,
        "stream": False
    }

    try:
        response = requests.post(OPENROUTER_API_URL, headers=headers, json=payload, timeout=60)
        response.raise_for_status() # Raise an exception for HTTP errors (4xx or 5xx)
        json_response = response.json()
        if json_response and json_response.get('choices') and json_response['choices'][0].get('message'):
            return {"text": json_response['choices'][0]['message']['content']}
        else:
            print(f"OpenRouter API returned unexpected structure: {json_response}")
            return {"error": "OpenRouter API returned unexpected response structure."}
    except requests.exceptions.HTTPError as http_err:
        print(f"OpenRouter API HTTP error with model {model_name}: {http_err} - {response.text}")
        if response.status_code == 401:
            return {"error": "OpenRouter API Key unauthorized. Please check your OPENROUTER_API_KEY."}
        elif response.status_code == 429:
            return {"error": "OpenRouter API rate limit exceeded. Please wait and try again."}
        else:
            return {"error": f"OpenRouter API returned error: {response.status_code} - {response.text}"}
    except requests.exceptions.ConnectionError as conn_err:
        print(f"OpenRouter API connection error with model {model_name}: {conn_err}")
        return {"error": "Could not connect to OpenRouter API. Please check your internet connection."}
    except requests.exceptions.Timeout as timeout_err:
        print(f"OpenRouter API timeout error with model {model_name}: {timeout_err}")
        return {"error": "OpenRouter API request timed out."}
    except requests.exceptions.RequestException as req_err:
        print(f"OpenRouter API request error with model {model_name}: {req_err}")
        return {"error": f"An unexpected request error occurred: {req_err}"}
    except json.JSONDecodeError as json_err:
        print(f"OpenRouter API JSON decode error with model {model_name}: {json_err} - Response: {response.text}")
        return {"error": "OpenRouter API returned invalid JSON."}
    except Exception as e:
        print(f"An unexpected error occurred during OpenRouter API call with model {model_name}: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def ask_ai_with_memory(user_id, chat_id, instruction, perform_search=False, model_choice="general"):
    """
    Sends a query to multiple AI APIs with a fallback mechanism.
    Order: Google Gemini -> Awan LLM -> Groq -> OpenRouter.
    Includes conversation memory and optional web search.
    """
    current_chat_history = load_chat_history_from_file(user_id, chat_id)

    # --- Conditional Web Search Logic ---
    if perform_search:
        search_query = instruction
        search_result = perform_web_search(search_query)

        search_bot_snippet = f"**Search results for:** _{search_query}_\n\n{search_result}"
        current_chat_history.append({
            "type": "bot",
            "text": search_bot_snippet,
            "timestamp": time.time()
        })

        instruction = (
            f"I've performed a web search for '{search_query}' and found the following information:\n\n"
            f"{search_result}\n\n"
            f"Based on this information and our previous conversation, please answer my original query: '{search_query}'"
        )
        print(f"Instructing AI with web search results: {instruction[:200]}...")

    # System instructions for different models
    system_instruction_text = (
        "You are Vexara, a smart and friendly AI assistant. You respond like a helpful expert — clear, friendly, and with enough depth to be useful. "
        "Give full answers, not just short replies. Explain code when needed. "
        "Crucially, when the user explicitly asks for code or code generation, your response MUST contain **ONLY** the code requested, formatted strictly within a markdown code block (e.g., ```python\\n...\\n```). "
        "Do NOT include any conversational filler or extra characters outside the markdown code block when outputting code. "
        "Sound like a real human who cares about helping. Always use Markdown for formatting your responses, especially for code blocks. "
        "Ensure code blocks are clearly marked with language names (like ```html, ```js, ```python, ```css). "
        "Structure your general answers like ChatGPT, using headings, bullet points, and a human tone. "
        "You are an expert in web development, AI, and creative frontend projects."
    )
    if model_choice == "deep_think":
        system_instruction_text = (
            "You are a highly analytical and deep reasoning AI. Focus on providing comprehensive, logical, and thoroughly reasoned answers. "
            "Break down complex problems, explore underlying principles, and offer detailed explanations. "
            "When generating code, provide robust solutions with clear logic. "
            "Maintain a formal yet helpful tone. Use Markdown extensively for structuring your detailed responses, including code blocks. "
            "For code generation, output ONLY the code within a markdown block."
        )

    # Build messages history for the API calls
    # Note: Different APIs might have slightly different expectations for system messages.
    # For simplicity, we'll use a common format here.
    ai_messages = []
    ai_messages.append({"role": "system", "content": system_instruction_text})
    # Add previous chat history
    for msg in current_chat_history:
        role = "user" if msg["type"] == "user" else "assistant"
        content = msg["text"]
        # If an image was involved, we've already processed it into text for the AI.
        # So, no special handling for 'image_url' here for text-based models.
        ai_messages.append({"role": role, "content": content})
    # Add the current user instruction
    ai_messages.append({"role": "user", "content": instruction})

    # --- API Fallback Mechanism ---
    # Try Google Gemini API first
    print("Attempting to call Google Gemini API...")
    gemini_response = call_gemini_api(ai_messages)
    if "text" in gemini_response:
        print("Successfully got response from Google Gemini API.")
        return gemini_response["text"].strip()
    else:
        print(f"Google Gemini API failed: {gemini_response.get('error', 'Unknown error')}. Falling back...")

    # Try Awan LLM API second
    print("Attempting to call Awan LLM API...")
    awan_response = call_awan_api(ai_messages)
    if "text" in awan_response:
        print("Successfully got response from Awan LLM API.")
        return awan_response["text"].strip()
    else:
        print(f"Awan LLM API failed: {awan_response.get('error', 'Unknown error')}. Falling back...")

    # Try Groq API third
    print("Attempting to call Groq API...")
    groq_response = call_groq_api(ai_messages)
    if "text" in groq_response:
        print("Successfully got response from Groq API.")
        return groq_response["text"].strip()
    else:
        print(f"Groq API failed: {groq_response.get('error', 'Unknown error')}. Falling back...")

    # Try OpenRouter API as the last fallback
    print("Attempting to call OpenRouter API (last fallback)...")
    target_openrouter_model = OPENROUTER_GENERAL_MODEL if model_choice == "general" else OPENROUTER_DEEPTHINK_MODEL
    openrouter_response = call_openrouter_api(ai_messages, target_openrouter_model)
    if "text" in openrouter_response:
        print("Successfully got response from OpenRouter API.")
        return openrouter_response["text"].strip()
    else:
        print(f"OpenRouter API failed: {openrouter_response.get('error', 'Unknown error')}.")
        return f"Sorry, all AI services are currently unavailable or experiencing issues. Please try again later. Last error: {openrouter_response.get('error', 'No specific error reported.')}"


def summarize_text_mistral(text_to_summarize):
    """Summarizes text using the fallback mechanism, prioritizing general models."""
    prompt = f"Summarize the following text concisely and in plain language:\n\n{text_to_summarize}"
    messages = [
        {"role": "user", "content": "You are a concise summarization expert."},
        {"role": "assistant", "content": "Understood. Please provide the text to summarize."},
        {"role": "user", "content": prompt}
    ]
    # Use the main ask_ai_with_memory function to leverage the fallback logic
    summary = ask_ai_with_memory(user_id="system_summarizer", chat_id="temp_summarizer", instruction=prompt, model_choice="general")
    
    if summary.startswith("Sorry, all AI services are currently unavailable"):
        print(f"Summarization failed: {summary}")
        return f"I cannot summarize this content: {summary}"
    return summary

def check_grammar_and_style_mistral(text_to_check):
    """Uses the fallback mechanism to check grammar and style."""
    prompt = f"Please correct the grammar and improve the writing style of the following text. Provide the corrected text and briefly explain any significant changes:\n\n{text_to_check}"
    messages = [
        {"role": "user", "content": "You are a grammar and style expert. Provide corrections and brief explanations."},
        {"role": "assistant", "content": "Ready to review your text."},
        {"role": "user", "content": prompt}
    ]
    corrected_text = ask_ai_with_memory(user_id="system_grammar", chat_id="temp_grammar", instruction=prompt, model_choice="general")
    
    if corrected_text.startswith("Sorry, all AI services are currently unavailable"):
        print(f"Grammar/Style check failed: {corrected_text}")
        return f"I cannot check this content: {corrected_text}"
    return corrected_text

def explain_code_mistral(code_to_explain):
    """Uses the fallback mechanism to explain code."""
    prompt = f"Please explain the following code. Break down its functionality, explain key parts, and provide insights into its purpose and usage. Use Markdown for formatting, especially for code snippets:\n\n\n{code_to_explain}\n"
    messages = [
        {"role": "user", "content": "You are a code explanation expert. Provide detailed and well-formatted explanations."},
        {"role": "assistant", "content": "I can help explain code. Please provide it."},
        {"role": "user", "content": prompt}
    ]
    explanation = ask_ai_with_memory(user_id="system_code_explain", chat_id="temp_code_explain", instruction=prompt, model_choice="general")
    
    if explanation.startswith("Sorry, all AI services are currently unavailable"):
        print(f"Code explanation failed: {explanation}")
        return f"I cannot explain this code: {explanation}"
    return explanation

def generate_code_mistral(prompt_for_code, language=None):
    """Uses the fallback mechanism to generate code based on a prompt."""
    code_prompt = (
        "Generate code based on the following request:\n\n"
        f"'{prompt_for_code}'\n\n"
    )
    if language:
        code_prompt += f"The code should be in {language}. "
        code_prompt += f"Your entire response MUST be ONLY the code, strictly enclosed in a markdown code block (e.g., ```{language}\\n...\\n```). "
    else:
        code_prompt += "Choose the most appropriate language for the request. "
        code_prompt += "Your entire response MUST be ONLY the code, strictly enclosed in a markdown code block (e.g., ```python\\n...\\n```). "
    code_prompt += "Include complete, well-commented code, ready to be used. ABSOLUTELY DO NOT include any conversational text, explanations, or leading/trailing sentences outside the markdown code block. If you need to make assumptions or provide context, document them as comments *inside* the generated code."

    messages = [
        {"role": "user", "content": "You are a code generation expert. Provide only the requested code in a markdown block."},
        {"role": "assistant", "content": "I am ready to generate code. Please provide your request."},
        {"role": "user", "content": code_prompt}
    ]
    generated_code_response = ask_ai_with_memory(user_id="system_code_gen", chat_id="temp_code_gen", instruction=code_prompt, model_choice="general")
    
    if generated_code_response.startswith("Sorry, all AI services are currently unavailable"):
        print(f"Code generation failed: {generated_code_response}")
        return f"I cannot generate code for this request: {generated_code_response}"
    return generated_code_response


# --- REMOVED IMAGE GENERATION ENDPOINT ---
# @app.route("/generate_image", methods=["POST"])
# def generate_image_endpoint():
#     # ... (removed Stable Diffusion code)
#     pass
# --- END REMOVED IMAGE GENERATION ENDPOINT ---


def check_tesseract_installed():
    """Checks if Tesseract OCR is installed."""
    try:
        pytesseract.get_tesseract_version()
        return True
    except pytesseract.TesseractNotFoundError:
        print("Tesseract is not installed or not found in PATH/configured. OCR features will be unavailable.")
        return False
    except Exception as e:
        print(f"An unexpected error occurred while checking Tesseract: {e}")
        return False

# --- Flask Routes ---

@app.route('/')
def index():
    """Renders the main application page."""
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def handle_query():
    """
    Handles AI chat queries with model selection, quota tracking, and caching.
    Automatically detects if the user wants to generate an image (now removed).
    """
    user_id = get_user_id()
    chat_id = request.form.get('chat_id') 
    instruction = request.form.get('instruction', '').strip()
    perform_search = request.form.get('web_search', 'false').lower() == 'true' 
    model_choice = request.form.get('model_choice', 'general').lower() # Get model choice from frontend

    if not chat_id:
        return jsonify({"response": "Error: Chat ID not provided."}), 400

    if not instruction:
        return jsonify({"response": "Please provide a valid input."}), 400

    # --- QUOTA ENFORCEMENT ---
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429
    
    # --- CACHE CHECK ---
    cached_response = get_from_cache(user_id, instruction)
    if cached_response:
        print(f"Serving response from cache for user {user_id}: {instruction[:50]}...")
        # Increment quota even if from cache, as it still counts as a "use" of the bot's service
        increment_daily_message_count(user_id)
        # Update chat history with cached response
        current_chat_history = load_chat_history_from_file(user_id, chat_id)
        current_chat_history.append({"type": "user", "text": instruction, "timestamp": time.time()})
        current_chat_history.append({"type": "bot", "text": cached_response, "timestamp": time.time()})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)
        return jsonify({"response": cached_response})

    # If not in cache, proceed with API call
    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": instruction, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    # Pass the model_choice to the AI function
    ai_response = ask_ai_with_memory(user_id, chat_id, instruction, perform_search, model_choice) 
    
    # Increment message count after a successful (or attempted) API call
    increment_daily_message_count(user_id)

    # Add to cache if the response was successful (not an error message from fallback)
    if not ai_response.startswith("Sorry, all AI services are currently unavailable"):
        add_to_cache(user_id, instruction, ai_response)

    current_chat_history = load_chat_history_from_file(user_id, chat_id) 
    current_chat_history.append({"type": "bot", "text": ai_response, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return ai_response



@app.route("/web_search", methods=["POST"])
def web_search_proxy():
    """Frontend proxy for web search (Serper API).
    This endpoint remains for compatibility but `perform_web_search` is now called directly from `/ask`.
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Missing JSON body."}), 400

        query = data.get("q")
        if not query:
            return jsonify({"error": "Missing search query."}), 400

        print(f"[Web Search] Query: {query}")

        # Direct call to Serper API (as originally in bot.py)
        serper_response = requests.post(
            "https://google.serper.dev/search",
            headers={
                "X-API-KEY": SERPER_API_KEY,
                "Content-Type": "application/json"
            },
            json={"q": query}
        )

        if serper_response.status_code != 200:
            return jsonify({"error": f"Serper API error (HTTP {serper_response.status_code}): {serper_response.text}"}), 500

        return jsonify(serper_response.json())

    except Exception as e:
        print(f"Web search route error: {e}")
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500


@app.route('/upload_image', methods=['POST'])
def upload_image_endpoint():
    """Handles image uploads and OCR processing, then sends text to AI."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id') 
    if not chat_id:
        return jsonify({"response": "Error: Chat ID not provided."}), 400

    if 'image' not in request.files or request.files['image'].filename == '':
        return jsonify({"response": "No image uploaded or selected."}), 400

    image_file = request.files['image']
    
    temp_image_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(image_file.filename)[1]) as temp_img_file:
            image_file.save(temp_img_file.name)
            temp_image_path = temp_img_file.name

        unique_filename = f"{int(time.time())}_{uuid.uuid4().hex}{os.path.splitext(image_file.filename)[1]}"
        static_image_path = os.path.join(UPLOAD_FOLDER, unique_filename)
        
        img_for_save = Image.open(temp_image_path)
        img_for_save.save(static_image_path)
        image_url_for_frontend = url_for('static', filename=f'uploads/{unique_filename}')

        extracted_text = ""
        # The check_tesseract_installed() ensures pytesseract is used if available.
        # No calls to Gemini Vision API are made here.
        if check_tesseract_installed():
            try:
                img_for_ocr = Image.open(temp_image_path)
                if img_for_ocr.mode != 'RGB':
                    img_for_ocr = img_for_ocr.convert('RGB')
                extracted_text = pytesseract.image_to_string(img_for_ocr)
                print(f"OCR extracted text: {extracted_text[:100]}...")
            except Exception as ocr_e:
                print(f"Error during OCR: {ocr_e}")
                extracted_text = " (OCR failed to extract text)"
        else:
            print("WARNING: Tesseract not installed or configured. Skipping OCR.")

        caption = request.form.get('caption', '').strip()
        user_message_text_part = ""
        if caption:
            user_message_text_part += f"Caption: {caption}\n"
        if extracted_text.strip():
            user_message_text_part += f"Extracted text from image:\n```\n{extracted_text.strip()}\n```"
        
        if not user_message_text_part.strip():
            user_message_text_part = "Please analyze this image."
        
        current_chat_history = load_chat_history_from_file(user_id, chat_id)
        current_chat_history.append({"type": "user", "text": user_message_text_part, "image_url": image_url_for_frontend, "timestamp": time.time()})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)

        # For AI, we pass the text content (caption + OCR) as the user message.
        # Default to 'general' model for image analysis unless specified otherwise.
        # User did not specify using deep_think model for image analysis.
        ai_response_text = ask_ai_with_memory(user_id, chat_id, user_message_text_part, model_choice="general")

        current_chat_history = load_chat_history_from_file(user_id, chat_id)
        current_chat_history.append({"type": "bot", "text": ai_response_text,})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)

        return jsonify({
            "response": ai_response_text,
            "image_url": image_url_for_frontend,
            "caption": caption
        })

    except Exception as e:
        print(f"Error processing image upload: {e}")
        return jsonify({"response": f"Error processing image: {str(e)}"}), 500
    finally:
        if temp_image_path and os.path.exists(temp_image_path):
            os.unlink(temp_image_path)


@app.route('/summarize_text', methods=['POST'])
def summarize_text_endpoint():
    """Handles text summarization requests."""
    user_id = get_user_id()
    chat_id = request.json.get('chat_id')
    if not chat_id:
        return jsonify({"error": "Error: Chat ID not provided for summarization."}), 400

    text_to_summarize = request.json.get('text', '').strip()
    if not text_to_summarize:
        return jsonify({"error": "No text provided for summarization."}), 400

    # Check quota before processing
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": f"Summarize: {text_to_summarize[:100]}...", "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    summary = summarize_text_mistral(text_to_summarize)
    
    # Increment message count after a successful (or attempted) API call
    increment_daily_message_count(user_id)

    if summary and not summary.startswith("Sorry, all AI services are currently unavailable"):
        current_chat_history = load_chat_history_from_file(user_id, chat_id)
        current_chat_history.append({"type": "bot", "text": f"**Summary:** {summary}", "timestamp": time.time()})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)
        return jsonify({"summary": summary, "response": f"**Summary:** {summary}"})
    else:
        return jsonify({"error": "Failed to generate summary.", "response": summary}), 500

@app.route('/check_grammar_style', methods=['POST'])
def check_grammar_style_endpoint():
    """Endpoint for grammar and style checking."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    text_to_check = request.form.get('text', '').strip()

    if not chat_id:
        return jsonify({"error": "Chat ID not provided."}), 400
    if not text_to_check:
        return jsonify({"error": "No text provided for grammar and style check."}), 400

    # Check quota before processing
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": f"Please check my grammar and style: {text_to_check}", "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    corrected_text = check_grammar_and_style_mistral(text_to_check)
    
    # Increment message count after a successful (or attempted) API call
    increment_daily_message_count(user_id)

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "bot", "text": corrected_text, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"corrected_text": corrected_text, "response": corrected_text})

@app.route('/explain_code', methods=['POST'])
def explain_code_endpoint():
    """Endpoint for code explanation."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    code_to_explain = request.form.get('code', '').strip()

    if not chat_id:
        return jsonify({"error": "Chat ID not provided."}), 400
    if not code_to_explain:
        return jsonify({"error": "No code provided for explanation."}), 400

    # Check quota before processing
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": f"Explain this code:\n```\n{code_to_explain}\n```", "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    explanation = explain_code_mistral(code_to_explain)
    
    # Increment message count after a successful (or attempted) API call
    increment_daily_message_count(user_id)

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "bot", "text": explanation, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"explanation": explanation, "response": explanation})

@app.route('/generate_code', methods=['POST'])
def generate_code_endpoint():
    """Endpoint for code generation."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    prompt_for_code = request.form.get('instruction', '').strip()
    language = request.form.get('language', None)

    if not chat_id:
        return jsonify({"error": "Chat ID not provided."}), 400
    if not prompt_for_code:
        return jsonify({"error": "No prompt provided for code generation."}), 400

    # Check quota before processing
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429

    user_message_text = f"Generate code for: '{prompt_for_code}'"
    if language:
        user_message_text += f" (Language: {language})"
    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": user_message_text, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    generated_code_response = generate_code_mistral(prompt_for_code, language)
    
    # Increment message count after a successful (or attempted) API call
    increment_daily_message_count(user_id)

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "bot", "text": generated_code_response, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"code": generated_code_response, "response": generated_code_response})


@app.route('/start_new_chat', methods=['POST'])
def start_new_chat_endpoint():
    """Handles starting a new chat session."""
    user_id = get_user_id()
    new_chat_id = str(uuid.uuid4())
    save_chat_history_to_file(user_id, new_chat_id, [])

    has_previous_chats = False
    for filename in os.listdir(CHAT_HISTORY_DIR):
        if filename.startswith(f"{user_id}_") and filename.endswith(".json") and filename != f"{user_id}_{new_chat_id}.json":
            has_previous_chats = True
            break

    return jsonify({"status": "success", "chat_id": new_chat_id, "has_previous_chats": has_previous_chats})

@app.route('/clear_all_chats', methods=['POST'])
def clear_all_chats_endpoint():
    """Deletes all chat history files for the current user."""
    user_id = get_user_id()
    try:
        count = 0
        for filename in os.listdir(CHAT_HISTORY_DIR):
            if filename.startswith(f"{user_id}_") and filename.endswith(".json"):
                os.remove(os.path.join(CHAT_HISTORY_DIR, filename))
                count += 1
        print(f"Cleared {count} chat files for user: {user_id}")
        return jsonify({"status": "success", "message": f"Cleared {count} chats."})
    except Exception as e:
        print(f"Error clearing all chats for user {user_id}: {e}")
        return jsonify({"status": "error", "message": "Failed to clear all chats.", "error": str(e)}), 500

@app.route('/get_chat_history_list', methods=['GET'])
def get_chat_history_list():
    """Returns a list of chat summaries for the current user."""
    user_id = get_user_id()
    chat_summaries = []
    
    user_chat_files = [f for f in os.listdir(CHAT_HISTORY_DIR) if f.startswith(f"{user_id}_") and f.endswith(".json")]
    
    user_chat_files.sort(key=lambda f: os.path.getmtime(os.path.join(CHAT_HISTORY_DIR, f)), reverse=True)

    for filename in user_chat_files:
        chat_id = filename.replace(f"{user_id}_", "").replace(".json", "")
        chat_data = load_chat_history_from_file(user_id, chat_id)
        
        display_title = "New Chat"
        if chat_data:
            first_meaningful_message = next((
                msg for msg in chat_data 
                if msg['type'] == 'user' and msg['text'].strip()
            ), None)

            if first_meaningful_message:
                display_title = first_meaningful_message['text'].split('\n')[0][:30]
                if len(first_meaningful_message['text'].split('\n')[0]) > 30:
                    display_title += "..."
            elif chat_data and chat_data[0]['type'] == 'bot':
                display_title = chat_data[0]['text'].split('\n')[0][:30]
                if len(chat_data[0]['text'].split('\n')[0]) > 30:
                    display_title += "..."
            if not display_title.strip() or display_title == "New Chat":
                display_title = f"Chat {chat_id[:8]}"
        else:
             display_title = f"Chat {chat_id[:8]}"


        chat_summaries.append({'id': chat_id, 'title': display_title})
    
    return jsonify(chat_summaries)

@app.route('/get_chat_messages/<chat_id>', methods=['GET'])
def get_chat_messages(chat_id):
    """Returns the full chat message history for a given chat ID."""
    user_id = get_user_id()
    chat_data = load_chat_history_from_file(user_id, chat_id)
    return jsonify(chat_data)


# --- Authentication Routes ---
@app.route('/google_login/authorized')
def google_login_authorized():
    """Handles Google OAuth callback."""
    if not google.authorized:
        print("Google authorization failed.")
        return redirect(url_for("login"))
    try:
        user_info = google.get("/oauth2/v2/userinfo")
        if user_info.ok:
            session['user'] = user_info.json().get("email")
            session['user_id'] = f"google_{user_info.json().get('id')}"
            print(f"User {session['user']} logged in with Google.")
            return redirect(url_for('index'))
        else:
            print(f"Google user info request failed: {user_info.text}")
            return redirect(url_for('login'))
    except Exception as e:
        print(f"Error during Google login: {e}")
        return redirect(url_for('login'))

@app.route('/login')
def login():
    """Handles user login (checks session or renders login page)."""
    if 'user_id' in session:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/guest_login')
def guest_login():
    """Logs in the user as a guest by assigning a temporary user ID."""
    session.clear()
    temp_id = str(uuid.uuid4())
    session['temp_user_id'] = temp_id
    session['user_id'] = temp_id
    session['is_guest'] = True
    print(f"User logged in as guest with temporary ID: {temp_id}")
    return redirect(url_for('index'))

@app.route('/logout')
def logout():
    """Logs out the user by clearing the session."""
    session.clear()
    return redirect(url_for('login'))

@app.route('/user_info', methods=['GET'])
def user_info():
    """Returns basic user information if logged in."""
    user_email = session.get('user', None)
    return jsonify({"user_email": user_email})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)


