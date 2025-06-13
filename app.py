from flask import Flask, render_template, request, jsonify, redirect, session, url_for
from flask_dance.contrib.google import make_google_blueprint, google
from authlib.integrations.flask_client import OAuth
from PIL import Image
import pytesseract
import os
import json
import google.generativeai as genai
import tempfile
import time

app = Flask(__name__)
app.secret_key = "your_fallback_secret"

# API KEYS
GEMINI_API_KEY = "AIzaSyDQJcS5wwBi65AdfW5zHT2ayu1ShWgWcJg"
HUGGINGFACE_API_KEY = "your_huggingface_api_key_here"  # Replace with your actual Huggingface API key

genai.configure(api_key="AIzaSyDQJcS5wwBi65AdfW5zHT2ayu1ShWgWcJg")
model = genai.GenerativeModel("gemini-1.5-flash")

# Configure Tesseract path (uncomment and modify for your OS if needed)
# pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'  # Windows
# pytesseract.pytesseract.tesseract_cmd = '/usr/local/bin/tesseract'  # macOS
# pytesseract.pytesseract.tesseract_cmd = '/usr/bin/tesseract'  # Linux

google_bp = make_google_blueprint(
    client_id="978102306464-qdjll3uos10m1nd5gcnr9iql9688db58.apps.googleusercontent.com",
    client_secret="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",
    redirect_url="/google_login/authorized"
)
app.register_blueprint(google_bp, url_prefix="/google_login")

oauth = OAuth(app)
microsoft = oauth.register(
    name='microsoft',
    client_id="your_microsoft_client_id",            # Replace with your Microsoft client ID
    client_secret="your_microsoft_client_secret",    # Replace with your Microsoft client secret
    access_token_url='https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authorize_url='https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    api_base_url='https://graph.microsoft.com/v1.0/',
    client_kwargs={'scope': 'User.Read'}
)

chat_memory = []
MAX_MEMORY = 100

def load_users():
    if os.path.exists("users.json"):
        with open("users.json") as f:
            return json.load(f)
    return {}

def save_users(users):
    with open("users.json", "w") as f:
        json.dump(users, f, indent=4)

def ask_ai_with_memory(memory_messages):
    try:
        system_instruction = (
            "You are Vexara, a smart and friendly AI assistant. "
            "You respond like a helpful expert — clear, friendly, and with enough depth to be useful. "
            "Give full answers, not just short replies. "
            "Explain code when needed. If the user asks for 'only code', provide only the code. "
            "Sound like a real human who cares about helping."
        )
        full_prompt = system_instruction + "\n" + "\n".join(
            [f"{m['role'].capitalize()}: {m['content']}" for m in memory_messages]
        )
        response = model.generate_content(full_prompt)
        return response.text.strip()
    except Exception as e:
        return f"⚠️ Gemini SDK error: {str(e)}"

def check_tesseract_installed():
    try:
        pytesseract.get_tesseract_version()
        return True
    except EnvironmentError:
        return False

@app.route('/')
def index():
    if 'user' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def handle_query():
    instruction = request.form.get('instruction', '').strip()
    if not instruction:
        return jsonify({"response": "Please provide a valid input"})

    chat_memory.append({"role": "user", "content": instruction})
    if len(chat_memory) > MAX_MEMORY:
        chat_memory[:] = chat_memory[-MAX_MEMORY:]

    ai_response = ask_ai_with_memory(chat_memory)
    chat_memory.append({"role": "assistant", "content": ai_response})
    return jsonify({"response": ai_response})

@app.route('/upload_image', methods=['POST'])
def upload_image():
    if 'image' not in request.files or request.files['image'].filename == '':
        return jsonify({"response": "No image uploaded or selected"})

    image = request.files['image']
    
    # Check if the file is an image
    if not image.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.gif')):
        return jsonify({"response": "Please upload a valid image file (PNG, JPG, JPEG, TIFF, BMP)"})

    try:
        # Save the uploaded image to a static folder
        upload_folder = os.path.join(app.root_path, 'static', 'uploads')
        os.makedirs(upload_folder, exist_ok=True)
        filename = f"{int(time.time())}_{image.filename}"
        image_path = os.path.join(upload_folder, filename)
        image.save(image_path)
        
        # Get relative URL for frontend
        image_url = url_for('static', filename=f'uploads/{filename}')

        # Process image with Tesseract
        img = Image.open(image_path)
        if img.mode != 'L':
            img = img.convert('L')
        text = pytesseract.image_to_string(img)

        if not text.strip():
            return jsonify({
                "response": "No text could be extracted from the image.",
                "image_url": image_url
            })

        # Get optional caption
        caption = request.form.get('caption', '').strip()
        user_message = f"Extracted text from image:\n{text}"
        if caption:
            user_message = f"Caption: {caption}\n{user_message}"

        # Process with AI
        chat_memory.append({"role": "user", "content": user_message})
        ai_response = ask_ai_with_memory(chat_memory)
        chat_memory.append({"role": "assistant", "content": ai_response})

        return jsonify({
            "response": ai_response,
            "image_url": image_url,
            "caption": caption
        })

    except Exception as e:
        return jsonify({"response": f"Error processing image: {str(e)}"})

@app.route('/google_login/authorized')
def google_login_authorized():
    if not google.authorized:
        return redirect(url_for("login"))
    user_info = google.get("/oauth2/v2/userinfo")
    if user_info.ok:
        session['user'] = user_info.json().get("email")
        return redirect(url_for('index'))
    return redirect(url_for('login'))

@app.route('/login')
def login():
    if google.authorized:
        user_info = google.get('/oauth2/v2/userinfo')
        if user_info.ok:
            session['user'] = user_info.json().get('email')
            return redirect(url_for('index'))
    elif 'microsoft_token' in session:
        return redirect(url_for('index'))
    return render_template('index.html')

@app.route('/start_new_chat', methods=['POST'])
def start_new_chat():
    global chat_memory
    chat_memory = []
    return jsonify({"response": "New chat started. How can I assist you today?"})

@app.route('/google-login')
def google_login():
    return google.authorize(callback=url_for('google_login_authorized', _external=True))

@app.route('/microsoft_login')
def microsoft_login():
    redirect_uri = url_for('microsoft_authorize', _external=True)
    return microsoft.authorize_redirect(redirect_uri)

@app.route('/microsoft_authorize')
def microsoft_authorize():
    token = microsoft.authorize_access_token()
    user = microsoft.get('me').json()
    session['user'] = user.get('userPrincipalName')
    return redirect(url_for('index'))

@app.route('/logout')
def logout():
    session.pop('user', None)
    return redirect(url_for('login'))

if __name__ == "__main__":
    # Check Tesseract installation at startup
    if not check_tesseract_installed():
        print("\n⚠️ WARNING: Tesseract OCR is not properly installed.")
        print("Image upload and text extraction features will not work.")
        print("Please install Tesseract OCR for your platform:\n")
        print("Windows: Download from UB Mannheim's Tesseract page")
        print("macOS: Run 'brew install tesseract'")
        print("Linux: Run 'sudo apt install tesseract-ocr'\n")
    
    app.run(debug=True)
