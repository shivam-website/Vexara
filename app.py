
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
