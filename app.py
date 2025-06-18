import json
import base64
import requests
import time
import uuid  # Import uuid for unique user and chat IDs
import os # Import os for environment variables and path operations
from flask import Flask, render_template, request, jsonify, redirect, session, url_for, make_response
from flask_dance.contrib.google import make_google_blueprint, google
from authlib.integrations.flask_client import OAuth
from PIL import Image
import pytesseract  # Assuming tesseract is installed and configured
import google.generativeai as genai
import tempfile

app = Flask(__name__)
# Use an environment variable for the secret key for better security
# Replace "your_fallback_secret_key_here" with a strong, random key in production
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "your_fallback_secret_key_here")

# API KEYS from environment variables, with fallbacks for development.
# For Canvas, GEMINI_API_KEY can be left empty; Canvas will inject it.
# Keeping the user's explicit key here based on their input.
GEMINI_API_KEY = "AIzaSyDQJcS5wwBi65AdfW5zHT2ayu1ShWgWcJg"
HUGGINGFACE_API_KEY = os.environ.get("HUGGINGFACE_API_KEY", "your_huggingface_api_key_here") # Replace with your actual Huggingface API key if used

# Configure Gemini models
genai.configure(api_key=GEMINI_API_KEY)
# Using gemini-1.5-flash for general chat and summarization
chat_model = genai.GenerativeModel("gemini-1.5-flash")
# Using imagen-3.0-generate-002 for image generation as per overall instructions
image_gen_model_name = "imagen-3.0-generate-002"

# Directory for storing chat history files
CHAT_HISTORY_DIR = os.path.join(app.root_path, 'chat_history')
os.makedirs(CHAT_HISTORY_DIR, exist_ok=True)
# Directory for storing uploaded images
UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Tesseract OCR configuration (uncomment and modify for your OS if needed)
# pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'  # Windows
# pytesseract.pytesseract.tesseract_cmd = '/usr/local/bin/tesseract'  # macOS
# pytesseract.pytesseract.tesseract_cmd = '/usr/bin/tesseract'  # Linux

# OAuth configuration (unchanged as no changes requested here)
google_bp = make_google_blueprint(
    client_id="978102306464-qdjll3uos10m1nd5gcnr9iql9688db58.apps.googleusercontent.com",
    client_secret="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",
    redirect_url="/google_login/authorized",
    # It's good practice to define scope for Google OAuth
    scope=["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]
)
app.register_blueprint(google_bp, url_prefix="/google_login")

oauth = OAuth(app)
microsoft = oauth.register(
    name='microsoft',
    client_id="your_microsoft_client_id",  # Replace with your Microsoft client ID
    client_secret="your_microsoft_client_secret",  # Replace with your Microsoft client secret
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
    if 'user_id' in session: # 'user_id' is set by Google/Microsoft OAuth or as temp_user_id
        return session['user_id']
    # For unauthenticated users, create and store a unique session ID
    if 'temp_user_id' not in session:
        session['temp_user_id'] = str(uuid.uuid4())
    return session['temp_user_id']

def get_chat_file_path(user_id, chat_id):
    """Constructs the file path for a specific chat history."""
    # Ensure user_id is sanitized to be safe for a filename
    safe_user_id = "".join(c for c in user_id if c.isalnum() or c in ('-', '_')).strip()
    return os.path.join(CHAT_HISTORY_DIR, f"{safe_user_id}_{chat_id}.json")

def load_chat_history_from_file(user_id, chat_id):
    """Loads chat history for a given user and chat ID from a JSON file."""
    file_path = get_chat_file_path(user_id, chat_id)
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                print(f"Warning: Could not decode JSON from {file_path}. Starting with empty chat.")
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

# --- AI Interaction Functions ---

def ask_ai_with_memory(user_id, chat_id, instruction):
    """Sends a query to Gemini with conversation memory."""
    try:
        current_chat_history = load_chat_history_from_file(user_id, chat_id)

        # Prepare chat history for Gemini model
        gemini_chat_history = []
        
        # System instruction is best for model tuning
        system_instruction = (
            "You are Vexara, a smart and friendly AI assistant. "
            "You respond like a helpful expert — clear, friendly, and with enough depth to be useful. "
            "Give full answers, not just short replies. "
            "Explain code when needed. If the user asks for 'only code', provide only the code. "
            "Sound like a real human who cares about helping. "
            "Always use Markdown for formatting your responses, especially for code blocks. "
            "Ensure code blocks are clearly marked with language_name."
        )
        
        # Add system instruction only if the chat is new.
        # For existing chats, the instruction is implicit in past interactions.
        if not current_chat_history:
             # The first message in the history sets the tone and context
             gemini_chat_history.append({"role": "user", "parts": [{"text": system_instruction}]})
             gemini_chat_history.append({"role": "model", "parts": [{"text": "Hello! How can I assist you today?"}]})
        
        # Add existing chat history to the Gemini prompt
        for msg in current_chat_history:
            if msg['type'] == 'user':
                parts = [{"text": msg['text']}]
                # If there's an image URL for a historical user message, encode and add it
                if 'image_url' in msg and msg['image_url']:
                    try:
                        # Construct absolute path for image stored in static/uploads
                        image_basename = os.path.basename(msg['image_url'])
                        image_path_on_disk = os.path.join(UPLOAD_FOLDER, image_basename) # Use UPLOAD_FOLDER
                        if os.path.exists(image_path_on_disk):
                            with open(image_path_on_disk, "rb") as image_file:
                                encoded_image = base64.b64encode(image_file.read()).decode('utf-8')
                                # Guess MIME type or store it with the message
                                img_extension = os.path.splitext(image_basename)[1].lower()
                                mime_type = f"image/{img_extension[1:]}" if img_extension else "image/jpeg"
                                parts.append({
                                    "inlineData": {
                                        "mimeType": mime_type,
                                        "data": encoded_image
                                    }
                                })
                    except Exception as img_e:
                        print(f"Warning: Could not re-encode historical image {msg['image_url']}: {img_e}")
                gemini_chat_history.append({"role": "user", "parts": parts})
            elif msg['type'] == 'bot':
                gemini_chat_history.append({"role": "model", "parts": [{"text": msg['text']}]})
        
        # Add the current instruction from the user
        final_user_parts = [{"text": instruction}]
        gemini_chat_history.append({"role": "user", "parts": final_user_parts})

        # Call Gemini API
        response = chat_model.generate_content(gemini_chat_history)
        return response.text.strip()
    except genai.types.StopCandidateException as e:
        # This occurs when content generation is stopped, usually because of safety filters
        print(f"Gemini AI Error: Content generation stopped due to safety policies. {e}")
        return "I apologize, but I cannot generate a response for that query due to safety policies."
    except Exception as e:
        print(f"Gemini AI Error: {e}")
        return "Sorry, I'm having trouble processing your request right now. Please try again later."

def summarize_text_gemini(text_to_summarize):
    """Summarizes text using Gemini."""
    try:
        prompt = f"Summarize the following text concisely and in plain language:\n\n{text_to_summarize}"
        response = chat_model.generate_content(prompt)
        return response.text.strip()
    except genai.types.StopCandidateException as e:
        print(f"Summarization Error: Content generation stopped due to safety policies. {e}")
        return "I cannot summarize this content due to safety policies."
    except Exception as e:
        print(f"Summarization Error: {e}")
        return None

def enhance_image_prompt_gemini(raw_prompt):
    """Enhances a raw image generation prompt using Gemini."""
    try:
        prompt = f"Expand the following image generation idea into a detailed, descriptive prompt suitable for an advanced image generation model, focusing on visual details, style, and mood. Be very descriptive and creative, adding specific elements that would make a compelling image. Only provide the enhanced prompt, no conversational filler:\n\n'{raw_prompt}'"
        response = chat_model.generate_content(prompt)
        return response.text.strip()
    except genai.types.StopCandidateException as e:
        print(f"Prompt Enhancement Error: Content generation stopped due to safety policies. {e}")
        return raw_prompt # Return original if enhancement fails due to safety
    except Exception as e:
        print(f"Prompt Enhancement Error: {e}")
        return raw_prompt # Return original if enhancement fails

def generate_images_gemini_api(prompt):
    """
    Generates images using the Imagen-3.0-generate-002 model via Gemini API.
    Returns a list of base64 encoded image URLs.
    """
    api_key = GEMINI_API_KEY # Canvas will inject this if empty
    
    if not prompt:
        print("Error: Image generation prompt is empty.")
        return [], "Image generation prompt cannot be empty."

    payload = {
        "instances": [{"prompt": prompt}], # 'instances' expects a list of objects
        "parameters": {"sampleCount": 1} # Generate 1 image by default
    }
    
    # Corrected API URL: removed redundant prefix
    api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{image_gen_model_name}:predict?key={api_key}"

    headers = {'Content-Type': 'application/json'}

    try:
        response = requests.post(api_url, headers=headers, json=payload)
        response.raise_for_status() # Raise an HTTPError for bad responses (4xx or 5xx)
        result = response.json()

        image_urls = []
        if result and 'predictions' in result and len(result['predictions']) > 0:
            for prediction in result['predictions']:
                if 'bytesBase64Encoded' in prediction:
                    img_data = prediction['bytesBase64Encoded']
                    image_urls.append(f"data:image/png;base64,{img_data}")
            return image_urls, "Here is your generated image!"
        else:
            print(f"Error: No predictions found in image generation response. Result: {result}")
            return [], "Image generation failed: No valid images returned."

    except requests.exceptions.RequestException as e:
        print(f"Network or API request error during image generation: {e}")
        return [], f"Image generation failed: Network error. Please check your API key and network connection."
    except json.JSONDecodeError as e:
        print(f"JSON decode error during image generation: {e}")
        return [], "Image generation failed: Invalid response from the API."
    except Exception as e:
        print(f"An unexpected error occurred during image generation: {e}")
        return [], f"Image generation failed: An unexpected error occurred: {str(e)}"

def check_tesseract_installed():
    """Checks if Tesseract OCR is installed."""
    try:
        pytesseract.get_tesseract_version()
        return True
    except pytesseract.TesseractNotFoundError:
        return False
    except Exception as e:
        print(f"An error occurred while checking Tesseract: {e}")
        return False

# --- New AI Features using Gemini ---
def check_grammar_and_style_gemini(text_to_check):
    """Uses Gemini to check grammar and style."""
    try:
        prompt = f"Please correct the grammar and improve the writing style of the following text. Provide the corrected text and briefly explain any significant changes:\n\n{text_to_check}"
        response = chat_model.generate_content(prompt)
        return response.text.strip()
    except genai.types.StopCandidateException as e:
        print(f"Grammar/Style Check Error: Content generation stopped due to safety policies. {e}")
        return "I cannot check this content due to safety policies."
    except Exception as e:
        print(f"Grammar/Style Check Error: {e}")
        return "Sorry, I'm having trouble checking grammar and style right now."

def explain_code_gemini(code_to_explain):
    """Uses Gemini to explain code."""
    try:
        prompt = f"Please explain the following code. Break down its functionality, explain key parts, and provide insights into its purpose and usage. Use Markdown for formatting, especially for code snippets:\n\n\n{code_to_explain}\n"
        response = chat_model.generate_content(prompt)
        return response.text.strip()
    except genai.types.StopCandidateException as e:
        print(f"Code Explanation Error: Content generation stopped due to safety policies. {e}")
        return "I cannot explain this code due to safety policies."
    except Exception as e:
        print(f"Code Explanation Error: {e}")
        return "Sorry, I'm having trouble explaining the code right now."

# --- Flask Routes ---

@app.route('/')
def index():
    """Renders the main application page. Redirects to login if not authenticated."""
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def handle_query():
    """Handles AI chat queries."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id') 
    instruction = request.form.get('instruction', '').strip()

    if not chat_id:
        return jsonify({"response": "Error: Chat ID not provided."}), 400

    if not instruction:
        return jsonify({"response": "Please provide a valid input."}), 400

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": instruction, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    ai_response = ask_ai_with_memory(user_id, chat_id, instruction)
    
    current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload to avoid race conditions
    current_chat_history.append({"type": "bot", "text": ai_response, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"response": ai_response})

@app.route('/upload_image', methods=['POST'])
def upload_image_endpoint():
    """Handles image uploads and OCR processing, then sends to Gemini Vision."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id') 
    if not chat_id:
        return jsonify({"response": "Error: Chat ID not provided."}), 400

    if 'image' not in request.files or request.files['image'].filename == '':
        return jsonify({"response": "No image uploaded or selected."}), 400

    image_file = request.files['image']
    
    if not image_file.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.gif')):
        return jsonify({"response": "Please upload a valid image file (PNG, JPG, JPEG, TIFF, BMP)."}), 400

    temp_image_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(image_file.filename)[1]) as temp_img_file:
            image_file.save(temp_img_file.name)
            temp_image_path = temp_img_file.name

        filename = f"{int(time.time())}_{image_file.filename}"
        static_image_path = os.path.join(UPLOAD_FOLDER, filename)
        Image.open(temp_image_path).save(static_image_path)
        image_url_for_frontend = url_for('static', filename=f'uploads/{filename}')

        with open(temp_image_path, "rb") as image_data_file:
            encoded_image_for_gemini = base64.b64encode(image_data_file.read()).decode('utf-8')
            img_extension = os.path.splitext(image_file.filename)[1].lower()
            mime_type = f"image/{img_extension[1:]}" if img_extension else "image/jpeg"
            gemini_image_part = {
                "inlineData": {
                    "mimeType": mime_type,
                    "data": encoded_image_for_gemini
                }
            }

        extracted_text = ""
        if check_tesseract_installed():
            try:
                img_for_ocr = Image.open(temp_image_path)
                if img_for_ocr.mode != 'RGB':
                    img_for_ocr = img_for_ocr.convert('RGB')
                extracted_text = pytesseract.image_to_string(img_for_ocr)
            except Exception as ocr_e:
                print(f"Error during OCR: {ocr_e}")
                extracted_text = " (OCR failed to extract text)"
        else:
            print("WARNING: Tesseract not installed. Skipping OCR.")

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

        try:
            response_model_for_vision = genai.GenerativeModel("gemini-1.5-flash") 
            gemini_vision_response = response_model_for_vision.generate_content([{"text": user_message_text_part}, gemini_image_part])
            ai_response_text = gemini_vision_response.text.strip()
        except genai.types.StopCandidateException as e:
            print(f"Gemini Vision Error: Content generation stopped due to safety policies. {e}")
            ai_response_text = "I apologize, but I cannot analyze this image due to safety policies."
        except Exception as e:
            print(f"Gemini Vision Error: {e}")
            ai_response_text = f"Sorry, I'm having trouble analyzing the image: {str(e)}"

        current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload
        current_chat_history.append({"type": "bot", "text": ai_response_text, "timestamp": time.time()})
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

@app.route('/generate_image', methods=['POST'])
def generate_image_endpoint():
    """Handles image generation requests."""
    user_id = get_user_id()
    chat_id = request.form.get('chat_id')
    if not chat_id:
        return jsonify({"response": "Error: Chat ID not provided."}), 400

    instruction = request.form.get('instruction', '').strip()
    if not instruction:
        return jsonify({"response": "Please provide a prompt for image generation."}), 400

    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": instruction, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    try:
        enhanced_prompt = enhance_image_prompt_gemini(instruction)
        image_urls, gen_response_text = generate_images_gemini_api(enhanced_prompt)

        current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload
        current_chat_history.append({"type": "bot", "text": gen_response_text, "image_urls": image_urls, "timestamp": time.time()})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)

        return jsonify({
            "response": gen_response_text,
            "image_urls": image_urls
        })
    except Exception as e:
        print(f"Error in /generate_image_endpoint: {e}")
        return jsonify({"response": f"Error generating image: {str(e)}"}), 500

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

    summary = summarize_text_gemini(text_to_summarize)
    if summary:
        current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload
        current_chat_history.append({"type": "bot", "text": f"**Summary:** {summary}", "timestamp": time.time()})
        save_chat_history_to_file(user_id, chat_id, current_chat_history)
        return jsonify({"summary": summary})
    else:
        return jsonify({"error": "Failed to generate summary."}), 500

# New Routes for LLM features
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

    # Add user message to history
    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": f"Please check my grammar and style: {text_to_check}", "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    corrected_text = check_grammar_and_style_gemini(text_to_check)
    
    # Add bot response to history
    current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload
    current_chat_history.append({"type": "bot", "text": corrected_text, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"corrected_text": corrected_text})

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

    # Add user message to history
    current_chat_history = load_chat_history_from_file(user_id, chat_id)
    current_chat_history.append({"type": "user", "text": f"Explain this code:\n```\n{code_to_explain}\n```", "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    explanation = explain_code_gemini(code_to_explain)
    
    # Add bot response to history
    current_chat_history = load_chat_history_from_file(user_id, chat_id) # Reload
    current_chat_history.append({"type": "bot", "text": explanation, "timestamp": time.time()})
    save_chat_history_to_file(user_id, chat_id, current_chat_history)

    return jsonify({"explanation": explanation})


@app.route('/start_new_chat', methods=['POST'])
def start_new_chat_endpoint():
    """Handles starting a new chat session."""
    user_id = get_user_id()
    new_chat_id = f"chat_{int(time.time())}" 
    save_chat_history_to_file(user_id, new_chat_id, []) # Initialize an empty chat file

    # Check if there are any other chats for this user to tell the frontend
    has_previous_chats = False
    # Filter out the newly created chat file from the list
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
    
    # Sort files by modification time (most recent first)
    user_chat_files.sort(key=lambda f: os.path.getmtime(os.path.join(CHAT_HISTORY_DIR, f)), reverse=True)

    for filename in user_chat_files:
        chat_id = filename.replace(f"{user_id}_", "").replace(".json", "")
        chat_data = load_chat_history_from_file(user_id, chat_id)
        
        display_title = "New Chat"
        if chat_data:
            first_user_message = next((msg for msg in chat_data if msg['type'] == 'user'), None)
            if first_user_message:
                display_title = first_user_message['text'].split('\n')[0][:30] # Take first line, truncate
                if len(first_user_message['text'].split('\n')[0]) > 30:
                    display_title += "..."
            elif chat_data[0]['type'] == 'bot': # If first message is bot (e.g., "Welcome")
                display_title = chat_data[0]['text'].split('\n')[0][:30]
                if len(chat_data[0]['text'].split('\n')[0]) > 30:
                    display_title += "..."

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
            session['user_id'] = f"google_{user_info.json().get('id')}" # More stable user ID
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
    if 'user_id' in session: # Check for our custom user_id
        return redirect(url_for('index'))
    
    # Prevent caching of the login page
    response = make_response(render_template('login.html'))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route('/login_as_guest')
def login_as_guest():
    """Allows a user to continue as a guest."""
    session['temp_user_id'] = str(uuid.uuid4()) # Generate a temporary user ID
    session['user_id'] = session['temp_user_id'] # Use this as the primary user_id
    session['user'] = "Guest User" # Set a placeholder for display
    print(f"User logged in as Guest: {session['user_id']}")
    return redirect(url_for('index'))


@app.route('/google-login')
def google_login():
    """Initiates Google OAuth."""
    return redirect(url_for('google.login'))

@app.route('/microsoft_login')
def microsoft_login():
    """Initiates Microsoft OAuth."""
    redirect_uri = url_for('microsoft_authorize', _external=True)
    return microsoft.authorize_redirect(redirect_uri)

@app.route('/microsoft_authorize')
def microsoft_authorize():
    """Handles Microsoft OAuth callback."""
    try:
        token = microsoft.authorize_access_token()
        if token:
            user = microsoft.get('me').json()
            if user:
                session['user'] = user.get('userPrincipalName')
                session['user_id'] = f"microsoft_{user.get('id')}" # More stable user ID
                print(f"User {session['user']} logged in with Microsoft.")
                return redirect(url_for('index'))
            else:
                print("Microsoft user info request failed.")
                return redirect(url_for('login'))
        else:
            print("Microsoft authorization failed: No token received.")
            return redirect(url_for('login'))
    except Exception as e:
        print(f"Error during Microsoft login: {e}")
        return redirect(url_for('login'))

@app.route('/logout')
def logout():
    """Logs out the user."""
    session.pop('user', None)
    session.pop('user_id', None)
    session.pop('temp_user_id', None) # Clear temporary ID too
    return redirect(url_for('login'))


@app.route('/user_info')
def user_info():
    """Returns user information if logged in."""
    user_email = session.get('user', 'Not logged in')
    return jsonify({"user_email": user_email})


if __name__ == "__main__":
    # Check Tesseract installation at startup
    if not check_tesseract_installed():
        print("\n⚠️ WARNING: Tesseract OCR is not properly installed.")
        print("Image upload and text extraction features will not work.")
        print("Please install Tesseract OCR for your platform:\n")
        print("Windows: Download from UB Mannheim's Tesseract page")
        print("macOS: Run 'brew install tesseract'")
        print("Linux: Run 'sudo apt install tesseract-ocr'\n")
    
    app.run(debug=True, host='0.0.0.0', port=5000)

# The provided code seems to be cut off. Assuming it ends here for now.
# If there are more routes or main execution blocks, they would go after this.
# Example:
# if __name__ == '__main__':
#     app.run(debug=True)
