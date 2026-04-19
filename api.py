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
# import pytesseract
import tempfile
from datetime import datetime, date, timedelta
from flask_cors import CORS

app_name = '__main__'
if '__app_id__' in globals():
    app_name = globals()['__app_id__']
app = Flask(app_name)

CORS(app, resources={r"/*": {"origins": "*"}})

app.secret_key = os.getenv("FLASK_SECRET_KEY", str(uuid.uuid4()))

# --- API KEYS ---
GOOGLE_GEMINI_API_KEY = os.getenv("GOOGLE_GEMINI_API_KEY")
AWAN_API_KEY =os.getenv("AWAN_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
SERPER_API_KEY = os.getenv("SERPER_API_KEY")

# --- API Endpoints ---
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
AWAN_API_URL = "https://api.awanllm.com/v1/chat/completions"
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# --- Models ---
GEMINI_MODEL = "gemini-2.5-flash"
AWAN_MODEL = "Meta-Llama-3-8B-Instruct"
GROQ_MODEL = "mixtral-8x7b-32768"  # Stable, always available
OPENROUTER_GENERAL_MODEL = "mistralai/mistral-small-3.2-24b-instruct:free"
OPENROUTER_DEEPTHINK_MODEL = "deepseek/deepseek-chat-v3.1:free"

# Directories
CHAT_HISTORY_DIR = os.path.join(app.root_path, 'chat_history')
os.makedirs(CHAT_HISTORY_DIR, exist_ok=True)
UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- Quota Tracking ---
user_message_counts = {}
DAILY_MESSAGE_LIMIT = 20

def get_daily_message_count(user_id):
    """Retrieves the message count for the current user and day."""
    today_str = date.today().isoformat()
    if user_id not in user_message_counts:
        user_message_counts[user_id] = {}
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
    one_week_ago = (date.today() - timedelta(days=7)).isoformat()
    for d_str in list(user_message_counts[user_id].keys()):
        if d_str < one_week_ago:
            del user_message_counts[user_id][d_str]

# OAuth configuration
google_bp = make_google_blueprint(
    client_id="978102306464-qdjll3uos10m1nd5gcnr9iql9688db58.apps.googleusercontent.com",
    client_secret="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",
    redirect_url="/google_login/authorized",
    scope=["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]
)
app.register_blueprint(google_bp, url_prefix="/google_login")

oauth = OAuth(app)
microsoft = oauth.register(
    name='microsoft',
    client_id="your_microsoft_client_id",
    client_secret="your_microsoft_client_secret",
    access_token_url='https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authorize_url='https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    api_base_url='https://graph.microsoft.com/v1.0/',
    client_kwargs={'scope': 'User.Read'}
)

# --- SEE SYSTEM PROMPT (CRITICAL FOR EXAM-FOCUSED ANSWERS) ---
SEE_SYSTEM_PROMPT = """You are Vexara, a Math tutor for Class 10 SEE students in Nepal.

**ANSWER APPROACH:**

1. **For direct math problems:** Use arrow format (⇒), show work clearly
2. **For follow-up questions (explain, clarify, why, what does x mean):** Explain in simple language
3. **For word problems:** First define variables, THEN show solution with arrows

**FORMAT - USE ARROWS (⇒) FOR CALCULATIONS:**

### LEVEL 1 (Simple equations):
3x + 5 = 17
⇒ 3x = 17 - 5
⇒ 3x = 12
⇒ x = 4

### LEVEL 2 (Word problems - ALWAYS explain variables first):

**Problem:** Ram has twice as many rupees as Shyam. Together they have Rs 450. How much does each have?

**Setting up:**
Let Shyam's money = x (unknown - what we want to find)
Ram's money = 2x (twice of Shyam's)
Together = x + 2x = 450 (given condition)

**Solution:**
⇒ x + 2x = 450
⇒ 3x = 450
⇒ x = 450 ÷ 3
⇒ x = 150

**Answer:**
Shyam has Rs 150
Ram has Rs 2 × 150 = Rs 300

**FOLLOW-UP RULE:**
If student asks "explain", "why", "what does x mean", "how did you solve" - answer directly:
- Explain the concept
- Use simple words
- Show why each step works
- Don't just repeat arrows

**RULES:**
- NEVER use [Step 1] or "Step 1:"
- ALWAYS use ⇒ for calculations
- For word problems: Define what x means first
- Answer follow-ups - don't refuse legitimate clarification questions
- Keep explanations clear and student-friendly
- Only refuse if completely off-topic (like "what's the weather?")"""
# --- CHAT HISTORY MANAGEMENT ---
def get_user_id():
    """Gets a unique user ID. Prefers authenticated user ID."""
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
    """Loads chat history for a given user and chat ID from a JSON file."""
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
            json.dump(chat_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving chat history to {file_path}: {e}")

# --- HELPER: Build chat context for API ---
def build_gemini_messages(chat_history, new_instruction):
    """
    Builds the message list for Gemini API from chat history.
    Includes system prompt as first message context.
    """
    messages = []
    
    # Convert chat history to Gemini format
    for msg in chat_history:
        if msg.get('type') == 'user':
            messages.append({
                "role": "user",
                "parts": [{"text": msg.get('text', '')}]
            })
        elif msg.get('type') == 'bot':
            messages.append({
                "role": "model",
                "parts": [{"text": msg.get('text', '')}]
            })
    
    # Add the new user instruction
    messages.append({
        "role": "user",
        "parts": [{"text": new_instruction}]
    })
    
    return messages

def build_chat_completion_messages(chat_history, new_instruction):
    """
    Builds message list for OpenAI-compatible APIs (Groq, OpenRouter, Awan).
    """
    messages = [
        {"role": "system", "content": SEE_SYSTEM_PROMPT}
    ]
    
    # Add chat history
    for msg in chat_history:
        if msg.get('type') == 'user':
            messages.append({"role": "user", "content": msg.get('text', '')})
        elif msg.get('type') == 'bot':
            messages.append({"role": "assistant", "content": msg.get('text', '')})
    
    # Add new instruction
    messages.append({"role": "user", "content": new_instruction})
    
    return messages

# --- GEMINI API CALL ---
def call_gemini_api(messages, stream=False):
    """Calls Gemini API (Gemini does NOT support streaming via REST API)."""
    payload = {
        "contents": messages,
        "systemInstruction": {
            "parts": [{"text": SEE_SYSTEM_PROMPT}]
        },
        "generationConfig": {
            "temperature": 0.7,
            "topK": 40,
            "topP": 0.95,
            "maxOutputTokens": 2048,
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ]
    }
    
    url = f"{GEMINI_API_URL}?key={GOOGLE_GEMINI_API_KEY}"
    
    try:
        print(f"[DEBUG] Calling Gemini API (non-streaming) with {len(messages)} messages")
        response = requests.post(url, json=payload, timeout=60)
        print(f"[DEBUG] Gemini response status: {response.status_code}")
        
        if response.status_code != 200:
            print(f"[DEBUG] Gemini error response: {response.text[:500]}")
        
        response.raise_for_status()
        return response
    except Exception as e:
        print(f"Gemini API error: {e}")
        print(f"[DEBUG] API Key set: {bool(GOOGLE_GEMINI_API_KEY)}")
        if GOOGLE_GEMINI_API_KEY:
            print(f"[DEBUG] Key preview: {GOOGLE_GEMINI_API_KEY[:20]}...")
        return None

# --- GROQ API CALL ---
def call_groq_api(messages, stream=True):
    """Calls Groq API (fast LLM)."""
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": stream
    }
    
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    
    try:
        print(f"[DEBUG] Calling Groq with payload keys: {list(payload.keys())}")
        response = requests.post(GROQ_API_URL, json=payload, headers=headers, stream=stream, timeout=60)
        print(f"[DEBUG] Groq status: {response.status_code}")
        if response.status_code != 200:
            print(f"[DEBUG] Groq error response: {response.text[:500]}")
        response.raise_for_status()
        return response
    except Exception as e:
        print(f"Groq API error: {e}")
        return None

# --- OPENROUTER API CALL ---
def call_openrouter_api(messages, model, stream=True):
    """Calls OpenRouter API."""
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": stream
    }
    
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vexara.ai",
        "X-Title": "Vexara SEE Tutor"
    }
    
    try:
        response = requests.post(OPENROUTER_API_URL, json=payload, headers=headers, stream=stream, timeout=60)
        response.raise_for_status()
        return response
    except Exception as e:
        print(f"OpenRouter API error: {e}")
        return None

# --- MAIN /ask ENDPOINT (IMPROVED WITH SEE CONTEXT) ---
@app.route('/ask', methods=['POST'])
def ask_endpoint():
    """Main Q&A endpoint with SEE-specific prompting."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    instruction = request.form.get('instruction', '').strip()
    model_choice = request.form.get('model_choice', 'general')
    web_search_enabled = request.form.get('web_search', 'false').lower() == 'true'
    
    if not chat_id:
        return jsonify({"error": "Chat ID not provided."}), 400
    if not instruction:
        return jsonify({"error": "No instruction provided."}), 400
    
    # Check quota
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429
    
    # Load chat history
    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    
    # Save user message to history
    current_chat_history.append({"type": "user", "text": instruction, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)
    
    # Increment quota
    increment_daily_message_count(user_id)
    
    def generate_response():
        """Generator function for streaming response."""
        try:
            # Build messages for API
            gemini_messages = build_gemini_messages(current_chat_history, instruction)
            completion_messages = build_chat_completion_messages(current_chat_history, instruction)
            
            response = None
            full_response = ""
            
            # Try primary model based on choice
            if model_choice == "deep_think":
                # Use DeepThink model for complex problems
                print(f"Using DeepThink model for: {instruction[:50]}...")
                response = call_openrouter_api(completion_messages, OPENROUTER_DEEPTHINK_MODEL, stream=True)
                
                # Handle streaming for DeepThink
                if response and response.status_code == 200:
                    try:
                        for line in response.iter_lines():
                            if line:
                                line_str = line.decode('utf-8').strip() if isinstance(line, bytes) else line.strip()
                                if line_str.startswith('data: '):
                                    try:
                                        data = json.loads(line_str[6:])
                                        if 'choices' in data and len(data['choices']) > 0:
                                            choice = data['choices'][0]
                                            if 'delta' in choice and 'content' in choice['delta']:
                                                chunk = choice['delta']['content']
                                                full_response += chunk
                                                yield chunk
                                    except (json.JSONDecodeError, KeyError, TypeError):
                                        continue
                    except Exception as e:
                        print(f"DeepThink streaming error: {e}")
                
                # If DeepThink fails, fall back to Gemini (not Groq)
                if not full_response:
                    print("DeepThink failed or rate limited, falling back to Gemini...")
                    response = call_gemini_api(gemini_messages, stream=False)
                    
                    if response and response.status_code == 200:
                        try:
                            data = response.json()
                            if 'candidates' in data and len(data['candidates']) > 0:
                                candidate = data['candidates'][0]
                                if 'content' in candidate and 'parts' in candidate['content']:
                                    for part in candidate['content']['parts']:
                                        if 'text' in part:
                                            full_response = part['text']
                                            # Stream chunks to UI
                                            words = full_response.split(' ')
                                            chunk = ""
                                            for word in words:
                                                chunk += word + " "
                                                if len(chunk) > 50:
                                                    yield chunk
                                                    chunk = ""
                                            if chunk:
                                                yield chunk
                        except Exception as e:
                            print(f"Fallback Gemini error: {e}")
                    
            elif model_choice == "general":
                # Use Gemini for general questions (NO STREAMING - GET FULL RESPONSE)
                print(f"Using Gemini for: {instruction[:50]}...")
                response = call_gemini_api(gemini_messages, stream=False)
                
                if response and response.status_code == 200:
                    try:
                        data = response.json()
                        print(f"[DEBUG] Gemini response received")
                        
                        if 'candidates' in data and len(data['candidates']) > 0:
                            candidate = data['candidates'][0]
                            if 'content' in candidate and 'parts' in candidate['content']:
                                for part in candidate['content']['parts']:
                                    if 'text' in part:
                                        full_response = part['text']
                                        # Stream the response in chunks for UI
                                        # Split by sentences and yield gradually
                                        words = full_response.split(' ')
                                        chunk = ""
                                        for word in words:
                                            chunk += word + " "
                                            if len(chunk) > 50:  # Yield every ~50 chars
                                                yield chunk
                                                chunk = ""
                                        if chunk:
                                            yield chunk
                    except Exception as e:
                        print(f"Gemini JSON parse error: {e}")
                        yield f"Error parsing Gemini response: {str(e)}"
                else:
                    print(f"Gemini API failed with status {response.status_code if response else 'None'}")
                    # Fall back to Groq
                    print("Gemini failed, trying Groq...")
                    response = call_groq_api(completion_messages, stream=True)
                    
                    if response and response.status_code == 200:
                        try:
                            for line in response.iter_lines():
                                if line:
                                    line_str = line.decode('utf-8').strip() if isinstance(line, bytes) else line.strip()
                                    if line_str.startswith('data: '):
                                        try:
                                            data = json.loads(line_str[6:])
                                            if 'choices' in data and len(data['choices']) > 0:
                                                choice = data['choices'][0]
                                                if 'delta' in choice and 'content' in choice['delta']:
                                                    chunk = choice['delta']['content']
                                                    full_response += chunk
                                                    yield chunk
                                        except (json.JSONDecodeError, KeyError, TypeError):
                                            continue
                        except Exception as e:
                            print(f"Groq streaming error: {e}")
            
            if not full_response:
                yield "Error: Could not get a response from AI models. Please try again."
                return
            
            # Save bot response to history
            current_chat_history.append({"type": "bot", "text": full_response, "timestamp": time.time()})
            save_chat_history_to_file(user_id, chat_id, current_chat_history)
            
        except Exception as e:
            print(f"Error in /ask: {e}")
            import traceback
            traceback.print_exc()
            yield f"Error: {str(e)}"
    
    return app.response_class(generate_response(), mimetype='text/event-stream')

# --- OTHER REQUIRED ENDPOINTS (STUB VERSIONS) ---
@app.route('/start_new_chat', methods=['POST'])
def start_new_chat_endpoint():
    """Starts a new chat session."""
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
        return jsonify({"status": "success", "message": f"Cleared {count} chats."})
    except Exception as e:
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
        
        chat_summaries.append({'id': chat_id, 'title': display_title})
    
    return jsonify(chat_summaries)

@app.route('/get_chat_messages/<chat_id>', methods=['GET'])
def get_chat_messages(chat_id):
    """Returns the full chat message history for a given chat ID."""
    user_id = get_user_id()
    chat_data = load_chat_history_from_file(user_id, chat_id)
    return jsonify(chat_data)

@app.route('/login')
def login():
    """Handles user login."""
    if 'user_id' in session:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/guest_login')
def guest_login():
    """Logs in the user as a guest."""
    session.clear()
    temp_id = str(uuid.uuid4())
    session['temp_user_id'] = temp_id
    session['user_id'] = temp_id
    session['is_guest'] = True
    return redirect(url_for('index'))

@app.route('/logout')
def logout():
    """Logs out the user."""
    session.clear()
    return redirect(url_for('login'))

@app.route('/user_info', methods=['GET'])
def user_info():
    """Returns basic user information."""
    user_email = session.get('user', None)
    return jsonify({"user_email": user_email})

@app.route('/google_login/authorized')
def google_login_authorized():
    """Handles Google OAuth callback."""
    if not google.authorized:
        return redirect(url_for("login"))
    try:
        user_info = google.get("/oauth2/v2/userinfo")
        if user_info.ok:
            session['user'] = user_info.json().get("email")
            session['user_id'] = f"google_{user_info.json().get('id')}"
            return redirect(url_for('index'))
        else:
            return redirect(url_for('login'))
    except Exception as e:
        print(f"Error during Google login: {e}")
        return redirect(url_for('login'))

@app.route('/')
def index():
    """Main index route."""
    return render_template('index.html')

@app.route('/debug/test-gemini', methods=['GET'])
def debug_test_gemini():
    """Test Gemini API directly for debugging."""
    test_messages = [
        {
            "role": "user",
            "parts": [{"text": "What is 2+2? Answer in one sentence."}]
        }
    ]
    
    response = call_gemini_api(test_messages, stream=False)
    
    if not response or response.status_code != 200:
        return jsonify({
            "error": f"Gemini API failed with status {response.status_code if response else 'No response'}", 
            "key_set": bool(GOOGLE_GEMINI_API_KEY),
            "full_response": response.text if response else "No response"
        })
    
    try:
        data = response.json()
        print(f"[DEBUG] Full Gemini response: {json.dumps(data, indent=2)[:500]}")
        
        if 'candidates' in data and len(data['candidates']) > 0:
            candidate = data['candidates'][0]
            if 'content' in candidate and 'parts' in candidate['content']:
                for part in candidate['content']['parts']:
                    if 'text' in part:
                        return jsonify({
                            "success": True,
                            "response": part['text'],
                            "status_code": response.status_code
                        })
        
        return jsonify({
            "error": "No text found in response",
            "response_structure": str(data)[:200]
        })
    except Exception as e:
        return jsonify({
            "error": f"Error parsing response: {str(e)}",
            "response_text": response.text[:500] if response else "No response"
        })

# --- IMAGE UPLOAD & VISION ENDPOINT ---
@app.route('/upload_image', methods=['POST'])
def upload_image_endpoint():
    """Handle image upload and vision-based math problem solving."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    caption = request.form.get('caption', '').strip()
    
    if not chat_id:
        return jsonify({"error": "Chat ID not provided."}), 400
    
    # Check if file is in request
    if 'image' not in request.files:
        return jsonify({"error": "No image file provided."}), 400
    
    file = request.files['image']
    if file.filename == '':
        return jsonify({"error": "No file selected."}), 400
    
    if not file.filename.lower().endswith(('png', 'jpg', 'jpeg', 'gif', 'webp')):
        return jsonify({"error": "File must be an image (PNG, JPG, GIF, WebP)."}), 400
    
    # Check quota
    current_message_count = get_daily_message_count(user_id)
    if current_message_count >= DAILY_MESSAGE_LIMIT:
        return jsonify({"response": f"You have reached your daily message limit of {DAILY_MESSAGE_LIMIT}. Please try again tomorrow."}), 429
    
    # READ FILE IMMEDIATELY (before generator starts)
    try:
        image_data = base64.standard_b64encode(file.read()).decode('utf-8')
    except Exception as e:
        print(f"Error reading file: {e}")
        return jsonify({"error": f"Error reading image file: {str(e)}"}), 400
    
    def stream_image_response():
        """Stream the vision processing response."""
        try:
            # Build the message with image
            current_chat_history = load_chat_history_from_file(user_id, chat_id)
            
            # Create vision prompt
            vision_prompt = f"""You are a math tutor specializing in SEE exam preparation for Class 10 students in Nepal.

A student has uploaded an image of a math problem. Your task is to:
1. Analyze the image and identify the math problem
2. Explain what the problem is asking (in simple terms)
3. Solve it step-by-step
4. Explain the concept behind it
5. Provide the final answer clearly

The student's caption/note about this problem: {caption if caption else 'None provided'}

Follow the same format as you would for text-based questions - make it educational and SEE-exam focused."""
            
            # Call Gemini Vision API
            print(f"[DEBUG] Processing image for math problem solving...")
            
            vision_messages = [
                {
                    "role": "user",
                    "parts": [
                        {"text": vision_prompt},
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": image_data
                            }
                        }
                    ]
                }
            ]
            
            # Call Gemini with vision
            vision_response = call_gemini_api(vision_messages, stream=False)
            
            if not vision_response or vision_response.status_code != 200:
                yield f"Error: Could not process image. Status: {vision_response.status_code if vision_response else 'None'}"
                return
            
            try:
                data = vision_response.json()
                
                if 'candidates' in data and len(data['candidates']) > 0:
                    candidate = data['candidates'][0]
                    if 'content' in candidate and 'parts' in candidate['content']:
                        for part in candidate['content']['parts']:
                            if 'text' in part:
                                full_response = part['text']
                                
                                # Save to chat history
                                user_message = f"[Image Upload] {caption if caption else 'Math problem image'}"
                                current_chat_history.append({"type": "user", "text": user_message, "timestamp": time.time()})
                                current_chat_history.append({"type": "bot", "text": full_response, "timestamp": time.time()})
                                save_chat_history_to_file(user_id, chat_id, current_chat_history)
                                
                                # Increment quota
                                increment_daily_message_count(user_id)
                                
                                # Stream the response
                                words = full_response.split(' ')
                                chunk = ""
                                for word in words:
                                    chunk += word + " "
                                    if len(chunk) > 50:
                                        yield chunk
                                        chunk = ""
                                if chunk:
                                    yield chunk
                                return
                
                yield "Error: No text extracted from image analysis."
            except Exception as e:
                print(f"Vision response parse error: {e}")
                yield f"Error parsing vision response: {str(e)}"
        
        except Exception as e:
            print(f"Image processing error: {e}")
            import traceback
            traceback.print_exc()
            yield f"Error: {str(e)}"
    
    return app.response_class(stream_image_response(), mimetype='text/event-stream')

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
