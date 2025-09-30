// Global variables for chat management
let currentChatId = null;
let sidebarHidden = false; // Tracks if sidebar is manually collapsed on desktop
let isFullScreen = false; // Tracks if full screen chat mode is active
let abortController = null; // Global AbortController for stopping AI responses

// Voice Talk Globals
let recognition;
let synth = window.speechSynthesis;
let isVoiceTalkActive = false; // Controls the full-screen voice overlay
let isListening = false; // Controls SpeechRecognition state
let isSpeaking = false; // Controls SpeechSynthesis state
let pendingBotSpeechText = ""; // Global to hold the actual text that will be displayed after speaking
let speechQueue = []; // Queue for streaming speech synthesis
let isProcessingSpeechQueue = false; // Flag to manage speech queue processing
let selectedVoice = null; // Stores the selected voice for AI speech

// Web Audio API for visualizer
let audioContext;
let analyser;
let microphoneStream;
let animationFrameId;
let canvas, canvasCtx;
let bufferLength;
let dataArray;
// let aiVoiceSource; // Not directly used as SpeechSynthesis doesn't expose an audio source node

// Screen Share Globals
let screenShareStream = null;
let screenShareInterval = null;
let isScreenSharing = false;
const screenCaptureCanvas = document.createElement("canvas"); // Off-screen canvas
const screenCaptureCtx = screenCaptureCanvas.getContext("2d");
const screenShareVideoElement = document.getElementById(
  "screen-share-preview-video"
);
const screenSharePreviewContainer = document.getElementById(
  "screen-share-preview-container"
);

// Helper Functions
function scrollToBottom() {
  const chatbox = document.getElementById("chatbox");
  chatbox.scrollTop = chatbox.scrollHeight;
}

// Function to escape HTML entities for display within a text area or code block
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper to safely escape code inside template literals for onclick attribute
function escapeForTemplateLiteral(str) {
  return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

// Custom Marked.js Renderer for Code Blocks
const renderer = new marked.Renderer();
renderer.code = function (code, lang) {
  const language = lang || "plaintext";

  // Determine file type based on language for update button
  let fileType = "txt";
  if (["html", "javascript", "css"].includes(language.toLowerCase())) {
    fileType = "index.html";
  } else if (language.toLowerCase() === "python") {
    fileType = "test.py";
  }

  // Use highlight.js if language is supported; else escape raw code
  let highlighted = "";
  if (hljs.getLanguage(language)) {
    highlighted = hljs.highlight(code, { language }).value;
  } else {
    highlighted = escapeHtml(code);
  }

  return `
<div class="code-block">
<div class="code-header">
<span class="code-language">${language.toUpperCase()}</span>
<div>
  <button class="copy-btn" onclick="copyToClipboard(this)" aria-label="Copy code to clipboard">
      <i class="far fa-copy" aria-hidden="true"></i> Copy
  </button>
  <button class="update-code-btn" onclick="openCodeUpdateModal(\`${escapeForTemplateLiteral(
    code
  )}\`, '${fileType}')" aria-label="Update code file">
      <i class="fas fa-code" aria-hidden="true"></i> Update
  </button>
</div>
</div>
<pre><code class="language-${language}">${highlighted}</code></pre>
</div>
`;
};

// Override paragraph rendering to add default margins (optional)
renderer.paragraph = function (text) {
  return `<p>${text}</p>`;
};

// Marked.js options with highlight.js integration
marked.setOptions({
  breaks: true, // GitHub-flavored line breaks
  highlight: function (code, lang) {
    if (hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return escapeHtml(code);
  },
  renderer: renderer,
});

// Function to copy code to clipboard
window.copyToClipboard = function (button) {
  const codeBlock = button.closest(".code-block").querySelector("code");
  if (codeBlock) {
    const textToCopy = codeBlock.textContent || codeBlock.innerText;

    // Create a temporary textarea element to hold the text
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = textToCopy;
    tempTextArea.style.position = "fixed"; // Prevent scrolling to bottom of page
    tempTextArea.style.left = "-9999px"; // Move off-screen
    tempTextArea.style.top = "0";
    document.body.appendChild(tempTextArea);

    // Select the text in the textarea
    tempTextArea.focus();
    tempTextArea.select();

    try {
      // Execute the copy command
      const successful = document.execCommand("copy");
      if (successful) {
        button.innerHTML =
          '<i class="fas fa-check" aria-hidden="true"></i> Copied!';
        setTimeout(() => {
          button.innerHTML =
            '<i class="far fa-copy" aria-hidden="true"></i> Copy';
        }, 2000);
      } else {
        // Fallback for modern browsers if execCommand fails (e.g., due to restrictions)
        // This part might still fail in strict iframe environments, but it's the standard fallback.
        navigator.clipboard
          .writeText(textToCopy)
          .then(() => {
            button.innerHTML =
              '<i class="fas fa-check" aria-hidden="true"></i> Copied!';
            setTimeout(() => {
              button.innerHTML =
                '<i class="far fa-copy" aria-hidden="true"></i> Copy';
            }, 2000);
          })
          .catch((err) => {
            console.error(
              "Failed to copy text using navigator.clipboard:",
              err
            );
            // Provide user feedback if both methods fail
            button.innerHTML =
              '<i class="fas fa-times" aria-hidden="true"></i> Failed';
            setTimeout(() => {
              button.innerHTML =
                '<i class="far fa-copy" aria-hidden="true"></i> Copy';
            }, 2000);
          });
      }
    } catch (err) {
      console.error("Failed to copy text using document.execCommand:", err);
      // Fallback to navigator.clipboard if execCommand throws an error
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          button.innerHTML =
            '<i class="fas fa-check" aria-hidden="true"></i> Copied!';
          setTimeout(() => {
            button.innerHTML =
              '<i class="far fa-copy" aria-hidden="true"></i> Copy';
          }, 2000);
        })
        .catch((err) => {
          console.error(
            "Failed to copy text using navigator.clipboard (fallback):",
            err
          );
          button.innerHTML =
            '<i class="fas fa-times" aria-hidden="true"></i> Failed';
          setTimeout(() => {
            button.innerHTML =
              '<i class="far fa-copy" aria-hidden="true"></i> Copy';
          }, 2000);
        });
    } finally {
      // Clean up the temporary textarea
      document.body.removeChild(tempTextArea);
    }
  }
};

// Function to add a new message to the chatbox
function addMessage(
  text,
  type = "bot",
  optionalContent = null,
  timestamp = new Date()
) {
  const chatbox = document.getElementById("chatbox");
  const newChatPlaceholder = document.getElementById("new-chat-placeholder");
  if (newChatPlaceholder) {
    newChatPlaceholder.remove(); // Remove placeholder once messages start
  }

  const msg = document.createElement("div");
  msg.className = `chat-message ${type}-message pulse`; // Add pulse animation class

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerHTML = type === "user" ? "You" : "";

  const timestampSpan = document.createElement("span");
  timestampSpan.className = "message-timestamp";
  timestampSpan.textContent = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  // header.appendChild(timestampSpan);
  // msg.appendChild(header);

  const content = document.createElement("div");
  content.className = "message-content";
  // Warn if text content is unexpectedly empty for user messages
  if (type === "user" && !text.trim()) {
    console.warn(
      "User message text is empty. This might indicate an issue with backend message storage."
    );
    content.innerHTML = "*(No text provided)*"; // Placeholder for empty text
  } else {
    content.innerHTML = marked.parse(text); // Parse markdown content
  }
  msg.appendChild(content);

  // Append optional content (e.g., uploaded image or generated images)
  if (optionalContent) {
    if (optionalContent instanceof HTMLElement) {
      msg.appendChild(optionalContent);
    } else if (Array.isArray(optionalContent)) {
      const imageContainer = document.createElement("div");
      imageContainer.className = "message-images-container";
      optionalContent.forEach((imageUrl) => {
        const imgElement = document.createElement("img");
        imgElement.src = imageUrl;
        imgElement.alt = "Generated Image";
        imageContainer.appendChild(imgElement);
      });
      msg.appendChild(imageContainer);
    }
  }

  chatbox.appendChild(msg);
  scrollToBottom();

  // Highlight code blocks after adding message
  document.querySelectorAll(".chat-message code").forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (e) {
      console.warn("Highlight.js failed on block:", block, e);
      block.style.color = "var(--code-text-color)";
    }
  });
}

// Function to simulate typing effect for bot messages
// This function is now responsible for creating the initial message container
// and updating its content as chunks arrive.
let currentBotMessageElement = null; // Reference to the current bot message being typed
let currentBotMessageContentDiv = null; // Reference to the content div within that message
let currentBotMessageFullText = ""; // Accumulates the full text for saving/actions

// Global/module-level declaration for sentence detector
const sentenceRegex = /[^.!?]+[.!?]+/g; // Moved to global scope

function createStreamingBotMessage(timestamp = new Date()) {
  const chatbox = document.getElementById("chatbox");
  const newChatPlaceholder = document.getElementById("new-chat-placeholder");
  if (newChatPlaceholder) {
    newChatPlaceholder.remove(); // Remove placeholder once messages start
  }

  const msg = document.createElement("div");
  msg.className = `chat-message bot-message`; // No pulse on typing init

  const header = document.createElement("div");
  header.className = "message-header";
  // header.innerHTML = 'Vexara';

  const timestampSpan = document.createElement("span");
  timestampSpan.className = "message-timestamp";
  timestampSpan.textContent = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  header.appendChild(timestampSpan);
  msg.appendChild(header);

  currentBotMessageContentDiv = document.createElement("div");
  currentBotMessageContentDiv.className = "message-content";
  msg.appendChild(currentBotMessageContentDiv);

  chatbox.appendChild(msg);
  scrollToBottom();

  currentBotMessageElement = msg; // Store reference to the new message element
  currentBotMessageFullText = ""; // Reset full text accumulator
  pendingBotSpeechText = ""; // Ensure pending speech text is cleared for new message
  sentenceRegex.lastIndex = 0; // Reset regex state for new message
}

async function appendToStreamingBotMessage(chunk) {
  if (!currentBotMessageContentDiv) {
    console.error("No active bot message element to append to.");
    return;
  }

  currentBotMessageFullText += chunk;

  // If voice talk is active, try to speak chunks as sentences
  if (isVoiceTalkActive) {
    pendingBotSpeechText += chunk;
    let lastSpokenIndex = 0; // Track the end index of the last spoken sentence

    // Reset lastIndex for each new processing cycle of pendingBotSpeechText
    // This is crucial because pendingBotSpeechText is modified.
    sentenceRegex.lastIndex = 0;
    let match;

    // Loop to find all complete sentences in the current pendingBotSpeechText
    while ((match = sentenceRegex.exec(pendingBotSpeechText)) !== null) {
      const sentence = match[0].trim();
      if (sentence) {
        speakText(sentence);
        lastSpokenIndex = sentenceRegex.lastIndex; // Store the index up to which we've spoken
      }
    }

    // Remove the spoken sentences from the beginning of pendingBotSpeechText
    if (lastSpokenIndex > 0) {
      pendingBotSpeechText = pendingBotSpeechText.substring(lastSpokenIndex);
    }
    // No need to reset sentenceRegex.lastIndex here, it will be reset at the start of the next call.
  }
  // Always update innerHTML with parsed Markdown for immediate visual feedback
  currentBotMessageContentDiv.innerHTML = marked.parse(
    currentBotMessageFullText
  );

  currentBotMessageContentDiv.querySelectorAll("pre code").forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (e) {
      console.warn("Highlight.js failed on block during streaming:", block, e);
      block.style.color = "var(--code-text-color)";
    }
  });

  scrollToBottom();
}

async function finalizeStreamingBotMessage(image_urls = []) {
  if (!currentBotMessageElement) {
    console.error("No active bot message element to finalize.");
    return;
  }

  // Speak any remaining pending text if voice talk is active
  if (isVoiceTalkActive && pendingBotSpeechText) {
    await new Promise((resolve) => {
      const finalUtterance = new SpeechSynthesisUtterance(pendingBotSpeechText);
      finalUtterance.lang = "en-US";
      finalUtterance.pitch = 1.0; // Default pitch
      finalUtterance.rate = 1.0; // Default rate
      finalUtterance.voice = selectedVoice; // Apply selected voice
      finalUtterance.onend = resolve;
      finalUtterance.onerror = resolve; // Resolve even on error to finalize message
      synth.speak(finalUtterance);
    });
  }

  // Ensure the content is displayed if it wasn't during streaming (e.g., voice mode was active)
  // This will re-render the entire message with full Markdown parsing and highlighting.
  if (currentBotMessageContentDiv && currentBotMessageFullText) {
    // Check if full text exists
    currentBotMessageContentDiv.innerHTML = marked.parse(
      currentBotMessageFullText
    );
    currentBotMessageContentDiv
      .querySelectorAll("pre code")
      .forEach((block) => {
        try {
          hljs.highlightElement(block);
        } catch (e) {
          console.warn(
            "Highlight.js failed on block during streaming (finalize):",
            block,
            e
          );
          block.style.color = "var(--code-text-color)";
        }
      });
  }

  // Append images
  if (image_urls && image_urls.length > 0) {
    const imageContainer = document.createElement("div");
    imageContainer.className = "message-images-container";
    image_urls.forEach((imageUrl) => {
      const imgElement = document.createElement("img");
      imgElement.src = imageUrl;
      imgElement.alt = "Generated Image";
      imageContainer.appendChild(imgElement);
    });
    currentBotMessageElement.appendChild(imageContainer);
    scrollToBottom();
  }

  // Add action buttons
  if (currentBotMessageFullText.length > 100) {
    const messageActionsDiv = document.createElement("div");
    messageActionsDiv.className = "message-actions";

    const summarizeButton = document.createElement("button");
    summarizeButton.className = "message-action-btn";
    summarizeButton.innerHTML =
      '<i class="fas fa-sparkle" aria-hidden="true"></i> Summarize';
    summarizeButton.onclick = async () => {
      summarizeButton.disabled = true;
      summarizeButton.innerHTML =
        '<i class="fas fa-hourglass-half" aria-hidden="true"></i> Summarizing...';
      const summary = await summarizeText(currentBotMessageFullText);
      if (summary) {
        addMessage(`**Summary:** ${summary}`, "bot", null, new Date());
      }
      summarizeButton.disabled = false;
      summarizeButton.innerHTML =
        '<i class="fas fa-sparkle" aria-hidden="true"></i> Summarize';
    };
    messageActionsDiv.appendChild(summarizeButton);
    currentBotMessageElement.appendChild(messageActionsDiv);
  }

  // Clear references
  currentBotMessageElement = null;
  currentBotMessageContentDiv = null;
  currentBotMessageFullText = "";
  pendingBotSpeechText = ""; // Ensure this is cleared here too
  sentenceRegex.lastIndex = 0; // Ensure regex state is reset on finalization
  scrollToBottom(); // Final scroll to ensure everything is visible

  // If voice mode is active, restart listening after AI finishes speaking
  if (isVoiceTalkActive) {
    startListening();
  }
}

// AI Function Calls (stubs, assume backend handles actual API calls)
async function askAI(instruction, modelChoice, performSearch = false) {
  // Added performSearch parameter
  const textInput = document.getElementById("text-input");
  const loader = document.getElementById("loader");

  // Show loader BEFORE creating the streaming message
  loader.style.display = "block";
  showStopButton(); // Show stop button, hide send button
  stopSpeaking(); // Stop AI speech if any

  // Initialize AbortController for this request
  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    formData.append("instruction", instruction);
    formData.append("chat_id", currentChatId);
    formData.append("model_choice", modelChoice); // Append model choice
    formData.append("web_search", performSearch); // Pass the web_search flag

    const response = await fetch(`${window.location.origin}/ask`, {
      method: "POST",
      body: formData,
      signal: signal, // Pass the abort signal to the fetch request
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Server error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Hide loader once the actual streaming starts
    loader.style.display = "none";

    // Create the initial message container for streaming
    createStreamingBotMessage(new Date());

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        await appendToStreamingBotMessage(chunk);
      }
    }

    // Finalize the streaming message after stream finishes
    finalizeStreamingBotMessage();
  } catch (error) {
    loader.style.display = "none"; // Hide loader on error
    if (error.name === "AbortError") {
      console.log("Fetch aborted by user.");
      if (currentBotMessageContentDiv) {
        currentBotMessageContentDiv.innerHTML += `<p>*(Response stopped by user)*</p>`;
      } else {
        addMessage(`Response stopped by user.`, "bot", null, new Date());
      }
    } else {
      console.error("Error asking AI:", error);
      // If an error occurs, ensure the message is still added or updated
      if (currentBotMessageContentDiv) {
        currentBotMessageContentDiv.innerHTML += `<p>Error: ${error.message}</p>`;
      } else {
        addMessage(
          `Sorry, there was an error processing your request: ${error.message}. Please try again.`,
          "bot",
          null,
          new Date()
        );
      }
    }
    finalizeStreamingBotMessage(); // Attempt to finalize even on error
  } finally {
    textInput.value = "";
    textInput.style.height = "auto"; // Reset textarea height
    textInput.focus();
    showSendButton(); // Show send button, hide stop button
    abortController = null; // Clear the controller
  }
}

async function generateImage(prompt) {
  const textInput = document.getElementById("text-input");
  const loader = document.getElementById("loader");
  loader.style.display = "block";
  showStopButton(); // Show stop button
  stopSpeaking(); // Stop AI speech if any

  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    formData.append("instruction", prompt);
    formData.append("chat_id", currentChatId);

    const response = await fetch(`${window.location.origin}/generate_image`, {
      method: "POST",
      body: formData,
      signal: signal, // Pass the abort signal
    });
    const data = await response.json();

    loader.style.display = "none";

    if (data.image_urls && data.image_urls.length > 0) {
      addMessage(data.response, "bot", data.image_urls, new Date());
      if (isVoiceTalkActive && data.response) speakText(data.response);
    } else {
      addMessage(data.response, "bot", null, new Date());
      if (isVoiceTalkActive && data.response) speakText(data.response);
    }
  } catch (error) {
    loader.style.display = "none"; // Hide loader on error
    if (error.name === "AbortError") {
      console.log("Image generation aborted by user.");
      addMessage(`Image generation stopped by user.`, "bot", null, new Date());
    } else {
      addMessage(
        `Sorry, there was an error generating the image: ${error.message}. Please try again.`,
        "bot",
        null,
        new Date()
      );
    }
  } finally {
    textInput.value = "";
    textInput.style.height = "auto";
    textInput.focus();
    showSendButton(); // Show send button
    abortController = null;
    if (isVoiceTalkActive) startListening(); // Restart listening after AI finishes
  }
}

async function uploadImage(file, caption) {
  const loader = document.getElementById("loader");
  loader.style.display = "block"; // Show loader for upload
  showStopButton(); // Show stop button
  stopSpeaking(); // Stop AI speech if any

  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    formData.append("image", file);
    if (caption) {
      formData.append("caption", caption);
    }
    formData.append("chat_id", currentChatId);

    const response = await fetch(`${window.location.origin}/upload_image`, {
      method: "POST",
      body: formData,
      signal: signal, // Pass the abort signal
    });
    const data = await response.json();

    loader.style.display = "none"; // Hide loader after response
    if (data && data.response) {
      // Assuming the backend has already saved the user's message (caption + image) correctly.
      // Now, display the AI's response (which might contain extracted text) as a separate bot message.
      if (data.image_urls && data.image_urls.length > 0) {
        addMessage(data.response, "bot", data.image_urls, new Date());
        if (isVoiceTalkActive && data.response) speakText(data.response);
      } else {
        addMessage(data.response, "bot", null, new Date());
        if (isVoiceTalkActive && data.response) speakText(data.response);
      }
    } else {
      console.error(
        "Image upload failed: Received an empty response or no AI response."
      );
      addMessage(
        "Received an empty response from the server after image upload. Please try again.",
        "bot",
        null,
        new Date()
      );
    }
  } catch (error) {
    loader.style.display = "none"; // Hide loader on error
    if (error.name === "AbortError") {
      console.log("Image upload aborted by user.");
      addMessage(`Image upload stopped by user.`, "bot", null, new Date());
    } else {
      addMessage(
        `Failed to upload image due to network error: ${error.message}. Please try again.`,
        "bot",
        null,
        new Date()
      );
    }
  } finally {
    clearImagePreview(); // Clear preview in all cases
    showSendButton(); // Show send button
    abortController = null;
    if (isVoiceTalkActive) startListening(); // Restart listening after AI finishes
  }
}

// --- DEPRECATED: performWebSearch is no longer directly called from frontend for display ---
// It's kept here for reference but the logic is now handled by askAI with web_search flag
/*
async function performWebSearch(query) {
const textInput = document.getElementById('text-input');
const loader = document.getElementById('loader');
loader.style.display = 'block'; 
showStopButton(); // Show stop button
stopSpeaking(); // Stop AI speech if any

abortController = new AbortController();
const signal = abortController.signal;

const BACKEND_WEB_SEARCH_ENDPOINT = `${window.location.origin}/web_search`; 

try {
const response = await fetch(BACKEND_WEB_SEARCH_ENDPOINT, {
  method: 'POST',
  headers: {
      'Content-Type': 'application/json',
  },
  body: JSON.stringify({ q: query, chat_id: currentChatId }),
  signal: signal // Pass the abort signal
});

if (!response.ok) {
  let errorMessage = `Web search failed with status ${response.status}`;

  try {
      const cloned = response.clone(); // Clone the stream
      const errorData = await cloned.json();
      if (errorData?.error) {
          errorMessage = `Web search failed: ${errorData.error}`;
      }
  } catch (e) {
      try {
          const fallbackCloned = response.clone(); // Clone again to read text
          const text = await fallbackCloned.text();
          if (text && text.startsWith('<')) {
              errorMessage = "Server returned an HTML error page. Check if your backend route returns JSON.";
          } else {
              errorMessage = `Unexpected error response: ${text}`;
          }
      } catch (finalError) {
          errorMessage = `Could not read error body: ${finalError.message}`;
      }
  }

  throw new Error(errorMessage);
}

const data = await response.json();
loader.style.display = 'none';

// The backend now sends the formatted response directly in data.response
const botResponseText = data.response; 

addMessage(botResponseText, 'bot', null, new Date()); // Use addMessage for non-streaming
if (isVoiceTalkActive && botResponseText) speakText(botResponseText);

} catch (error) {
loader.style.display = 'none'; // Hide loader on error
if (error.name === 'AbortError') {
  console.log('Web search aborted by user.');
  addMessage(`Web search stopped by user.`, 'bot', null, new Date());
} else {
  addMessage(`Sorry, there was an error performing the web search: ${error.message}. Please try again.`, 'bot', null, new Date());
}
} finally {
textInput.value = '';
textInput.style.height = 'auto';
textInput.focus();
showSendButton(); // Show send button
abortController = null;
if (isVoiceTalkActive) startListening(); // Restart listening after AI finishes
}
}
*/
// --- END DEPRECATED: Web Search Functionality ---

async function summarizeText(textToSummarize) {
  try {
    const response = await fetch(`${window.location.origin}/summarize_text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: textToSummarize,
        chat_id: currentChatId,
      }),
    });
    const data = await response.json();
    if (data && data.summary) {
      return data.summary;
    } else {
      console.error(
        "Summarization failed:",
        data.error || "No summary returned."
      );
      return null;
    }
  } catch (error) {
    console.error("Error summarizing text:", error);
    return null;
  }
}

async function checkGrammarAndStyle(text) {
  const textInput = document.getElementById("text-input");
  const loader = document.getElementById("loader");
  loader.style.display = "block";
  showStopButton(); // Show stop button
  stopSpeaking(); // Stop AI speech if any

  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    formData.append("text", text);
    formData.append("chat_id", currentChatId);

    const response = await fetch(
      `${window.location.origin}/check_grammar_style`,
      {
        method: "POST",
        body: formData,
        signal: signal, // Pass the abort signal
      }
    );
    const data = await response.json();
    loader.style.display = "none";
    if (data && data.corrected_text) {
      addMessage(data.corrected_text, "bot", null, new Date());
      if (isVoiceTalkActive && data.corrected_text)
        speakText(data.corrected_text);
    } else {
      console.error(
        "Grammar/Style check failed:",
        data.error || "No response returned."
      );
      addMessage(
        data.error || "Failed to check grammar and style.",
        "bot",
        null,
        new Date()
      );
    }
  } catch (error) {
    loader.style.display = "none"; // Hide loader on error
    if (error.name === "AbortError") {
      console.log("Grammar check aborted by user.");
      addMessage(`Grammar check stopped by user.`, "bot", null, new Date());
    } else {
      addMessage(
        `Sorry, an error occurred while checking the grammar and style: ${error.message}. Please try again.`,
        "bot",
        null,
        new Date()
      );
    }
  } finally {
    textInput.value = "";
    textInput.style.height = "auto";
    textInput.focus();
    showSendButton(); // Show send button
    abortController = null;
    if (isVoiceTalkActive) startListening(); // Restart listening after AI finishes
  }
}

async function explainCode(code) {
  const textInput = document.getElementById("text-input");
  const loader = document.getElementById("loader");
  loader.style.display = "block";
  showStopButton(); // Show stop button
  stopSpeaking(); // Stop AI speech if any

  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    formData.append("code", code);
    formData.append("chat_id", currentChatId);

    const response = await fetch(`${window.location.origin}/explain_code`, {
      method: "POST",
      body: formData,
      signal: signal, // Pass the abort signal
    });
    const data = await response.json();
    loader.style.display = "none";
    if (data && data.explanation) {
      addMessage(data.explanation, "bot", null, new Date());
      if (isVoiceTalkActive && data.explanation) speakText(data.explanation);
    } else {
      console.error(
        "Code explanation failed:",
        data.error || "No response returned."
      );
      addMessage(
        data.error || "Failed to explain code.",
        "bot",
        null,
        new Date()
      );
    }
  } catch (error) {
    loader.style.display = "none"; // Hide loader on error
    if (error.name === "AbortError") {
      console.log("Code explanation aborted by user.");
      addMessage(`Code explanation stopped by user.`, "bot", null, new Date());
    } else {
      addMessage(
        `Sorry, an error occurred while explaining the code: ${error.message}. Please try again.`,
        "bot",
        null,
        new Date()
      );
    }
  } finally {
    textInput.value = "";
    textInput.style.height = "auto";
    textInput.focus();
    showSendButton(); // Show send button
    abortController = null;
    if (isVoiceTalkActive) startListening(); // Restart listening after AI finishes
  }
}

// UI Functions
function showModal() {
  document.getElementById("confirmModal").style.display = "flex";
}

function hideModal() {
  document.getElementById("confirmModal").style.display = "none";
}

// Show image preview in the input area
function showImagePreview(file) {
  const imagePreviewContainer = document.getElementById(
    "image-preview-container"
  );
  const imagePreview = document.getElementById("image-preview");
  const clearImageBtn = document.getElementById("clear-image-btn");

  const reader = new FileReader();
  reader.onload = function (e) {
    imagePreview.src = e.target.result;
    imagePreview.style.display = "block";
    imagePreviewContainer.style.display = "flex";
    clearImageBtn.style.display = "flex";
  };
  reader.readAsDataURL(file);
}

// Clear image preview from the input area
function clearImagePreview() {
  const imagePreviewContainer = document.getElementById(
    "image-preview-container"
  );
  const imagePreview = document.getElementById("image-preview");
  const clearImageBtn = document.getElementById("clear-image-btn");
  const takePhotoInput = document.getElementById("take-photo-input"); // Get new inputs
  const uploadPhotoInput = document.getElementById("upload-photo-input");
  const desktopFileInput = document.getElementById("desktop-file-input"); // NEW: Get desktop input

  imagePreview.src = "#";
  imagePreview.style.display = "none";
  imagePreviewContainer.style.display = "none";
  clearImageBtn.style.display = "none";
  if (takePhotoInput) takePhotoInput.value = ""; // Clear file inputs
  if (uploadPhotoInput) uploadPhotoInput.value = "";
  if (desktopFileInput) desktopFileInput.value = ""; // NEW: Clear desktop file input
}

// Toggle full screen mode
window.toggleFullScreen = function () {
  const body = document.body;
  isFullScreen = !isFullScreen;

  if (isFullScreen) {
    body.classList.add("full-screen-mode");
  } else {
    body.classList.remove("full-screen-mode");
    // Restore sidebar visibility based on previous state if on desktop
    if (window.innerWidth > 768 && !sidebarHidden) {
      document.getElementById("sidebar").classList.remove("collapsed");
      document.querySelector(".main").classList.remove("full-width");
    }
  }
  // Ensure the correct sidebar toggle button is shown/hidden after full screen toggle
  updateSidebarToggleButtonVisibility();
};

window.clearAllChats = function () {
  showModal();
};
window.startNewChat = async function (isInitialLoad = false) {
  const chatbox = document.getElementById("chatbox");
  const textInput = document.getElementById("text-input");
  const modelGeneralRadio = document.getElementById("modelGeneral");

  try {
    const response = await fetch(`${window.location.origin}/start_new_chat`, {
      method: "POST",
    });
    const data = await response.json();

    if (data.chat_id) {
      currentChatId = data.chat_id;

      // Clear chatbox first
      chatbox.innerHTML = "";

      // Add the welcome placeholder with logo
      const placeholderDiv = document.createElement("div");
      placeholderDiv.id = "new-chat-placeholder";
      placeholderDiv.className = "new-chat-placeholder";
      placeholderDiv.innerHTML = `
<img src="/static/images/vexara-new1-removebg-preview.png" alt="V" style="width: 60px; height: 60px;background-repeat: no-repeat;background-size: cover;" />
        <span>How can I help you?</span>
`;
      chatbox.appendChild(placeholderDiv);

      // Reset input field
      textInput.value = "";
      textInput.style.height = "auto";
      textInput.focus();
      textInput.setAttribute("required", "");
      textInput.placeholder = "Ask anything";

      clearImagePreview(); // Clear any existing image preview
      modelGeneralRadio.checked = true; // Set General Talk as default

      // Update chat history **after adding placeholder**
      await updateChatHistory();

      // If no messages loaded, make sure placeholder stays
      if (chatbox.children.length === 0) {
        chatbox.appendChild(placeholderDiv);
      }
    } else {
      console.error("Failed to get a new chat ID from backend.");
      addMessage(
        "Failed to start new chat. Please try refreshing the page.",
        "bot",
        null,
        new Date()
      );
    }
  } catch (error) {
    console.error("Error starting new chat:", error);
    addMessage(
      "Failed to start new chat due to network error. Please try again.",
      "bot",
      null,
      new Date()
    );
  }
};

window.toggleDarkMode = function () {
  document.body.classList.toggle("dark-mode");
  if (document.body.classList.contains("dark-mode")) {
    localStorage.setItem("darkMode", "enabled");
  } else {
    localStorage.removeItem("darkMode");
  }
};

// Handles sidebar visibility for both desktop collapse and mobile slide-out
window.toggleSidebar = function () {
  const sidebar = document.getElementById("sidebar");
  const mainContent = document.querySelector(".main");

  if (window.innerWidth <= 768 || isFullScreen) {
    // Mobile or Full Screen mode
    sidebar.classList.toggle("visible");
  } else {
    // Desktop
    sidebar.classList.toggle("collapsed");
    mainContent.classList.toggle("full-width");
    sidebarHidden = sidebar.classList.contains("collapsed"); // Update hidden state
  }
  updateSidebarToggleButtonVisibility(); // Update button visibility after toggling
};

// Helper function to manage sidebar toggle button visibility
function updateSidebarToggleButtonVisibility() {
  const sidebar = document.getElementById("sidebar");
  const showSidebarBtn = document.getElementById("showSidebarBtn");
  const sidebarToggleButton = document.getElementById("sidebarToggleButton"); // The button inside the sidebar

  if (window.innerWidth <= 768 || isFullScreen) {
    // Mobile or Full Screen mode
    if (sidebar.classList.contains("visible")) {
      showSidebarBtn.style.display = "none";
      sidebarToggleButton.style.display = "block";
      sidebarToggleButton.querySelector("i").className = "fi fi-rr-sidebar"; // Same icon
    } else {
      showSidebarBtn.style.display = "flex";
      sidebarToggleButton.style.display = "none";
      showSidebarBtn.querySelector("i").className = "fi fi-rr-sidebar"; // Same icon
    }
  } else {
    // Desktop
    if (sidebar.classList.contains("collapsed")) {
      showSidebarBtn.style.display = "flex"; // Show floating button to expand
      sidebarToggleButton.style.display = "none"; // Hide internal toggle
      showSidebarBtn.querySelector("i").className = "fi fi-rr-sidebar"; // Same icon
    } else {
      showSidebarBtn.style.display = "none"; // Hide floating button
      sidebarToggleButton.style.display = "block"; // Show internal toggle
      sidebarToggleButton.querySelector("i").className = "fi fi-rr-sidebar"; // Same icon
    }
  }
}

// Functions to toggle visibility of Send and Stop buttons
function showSendButton() {
  if (isVoiceTalkActive) return; // Do not show if voice talk is active
  document.getElementById("send-btn").style.display = "flex";
  document.getElementById("stop-btn").style.display = "none";
}

function showStopButton() {
  if (isVoiceTalkActive) return; // Do not show if voice talk is active
  document.getElementById("send-btn").style.display = "none";
  document.getElementById("stop-btn").style.display = "flex";
}

// NEW: Functions for the subtle talking animation
function showTalkingAnimation() {
  const talkingAnimation = document.getElementById("talking-animation");
  if (talkingAnimation) {
    talkingAnimation.classList.add("active");
  }
}

function hideTalkingAnimation() {
  const talkingAnimation = document.getElementById("talking-animation");
  if (talkingAnimation) {
    talkingAnimation.classList.remove("active");
  }
}

// Voice Talk Functions
const voiceTalkBtn = document.getElementById("voice-talk-btn");
const micIcon = voiceTalkBtn.querySelector("i");
const voiceModeOverlay = document.getElementById("voice-mode-overlay");
const mainContentElement = document.querySelector(".main"); // Renamed to avoid conflict with local variable
const micControlBtn = document.getElementById("mic-control-btn");
const closeVoiceModeBtn = document.getElementById("close-voice-mode-btn");
const voiceStatusTextOverlay = voiceModeOverlay.querySelector(".status-text");
const screenShareBtn = document.getElementById("screen-share-btn"); // New screen share button

function initializeSpeechRecognition() {
  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    recognition = new (window.SpeechRecognition ||
      window.webkitSpeechRecognition)();
    recognition.continuous = false; // Only listen for a single utterance
    recognition.interimResults = false; // Only return final results
    recognition.lang = "en-US"; // Set language

    recognition.onstart = () => {
      isListening = true;
      micControlBtn.classList.add("mic-active");
      micControlBtn.querySelector("i").className = "fas fa-microphone-alt"; // Listening icon
      voiceStatusTextOverlay.textContent = "Listening...";
      console.log("Speech recognition started.");
      stopSpeaking(); // Stop AI speech if user starts talking
      startVoiceVisualizer(false); // Start visualizer for user input
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      document.getElementById("text-input").value = transcript;
      console.log("Speech recognized:", transcript);
      // Automatically submit the form after speech is recognized
      document
        .getElementById("multi-action-form")
        .dispatchEvent(new Event("submit", { cancelable: true }));
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      micControlBtn.classList.remove("mic-active");
      micControlBtn.querySelector("i").className = "fas fa-microphone"; // Default icon on error
      isListening = false;
      stopVoiceVisualizer(); // Stop visualizer on error
      let errorMessage = "Speech error. Tap mic to retry.";
      if (event.error === "not-allowed") {
        errorMessage = "Microphone permission denied. Please allow access.";
        addMessage(
          "Microphone access denied. Please enable microphone permissions for this site in your browser settings to use voice features.",
          "bot",
          null,
          new Date()
        );
      } else if (event.error === "no-speech") {
        errorMessage = "No speech detected. Please try again.";
      } else if (event.error === "audio-capture") {
        errorMessage = "Microphone not found or busy. Check connections.";
      } else if (event.error === "network") {
        errorMessage = "Network error during speech recognition.";
      }
      voiceStatusTextOverlay.textContent = errorMessage;
      // Do NOT automatically restart here, let user tap again
    };

    recognition.onend = () => {
      console.log("Speech recognition ended.");
      isListening = false;
      micControlBtn.classList.remove("mic-active");
      micControlBtn.querySelector("i").className = "fas fa-microphone"; // Default icon
      stopVoiceVisualizer(); // Stop visualizer when listening ends
      if (isVoiceTalkActive && !isSpeaking) {
        voiceStatusTextOverlay.textContent = "Standard voice"; // Reset status text
        // Only restart listening if AI is not speaking and voice mode is still active
        // This will be handled by finalizeStreamingBotMessage or micControlBtn click
      } else if (!isVoiceTalkActive) {
        voiceStatusTextOverlay.textContent = "Standard voice";
      }
    };
  } else {
    voiceTalkBtn.disabled = true;
    voiceTalkBtn.title = "Voice talk not supported in your browser.";
    console.warn("Web Speech API not supported in this browser.");
    // Provide user feedback directly in chat if it's the first time they try
    addMessage(
      "Your browser does not support Web Speech Recognition. Please use a compatible browser like Chrome or Edge.",
      "bot",
      null,
      new Date()
    );
  }
}

function startListening() {
  if (recognition && isVoiceTalkActive && !isListening && !isSpeaking) {
    // Ensure not speaking
    try {
      recognition.start();
    } catch (e) {
      console.warn("Recognition already started or other error:", e);
      if (e.message.includes("already started")) {
        // Ignore if already started, but log for debugging
      } else if (e.message.includes("permission denied")) {
        voiceStatusTextOverlay.textContent =
          "Microphone permission denied. Please allow access.";
        addMessage(
          "Microphone access denied. Please enable microphone permissions for this site in your browser settings to use voice features.",
          "bot",
          null,
          new Date()
        );
      } else {
        voiceStatusTextOverlay.textContent =
          "Error starting mic. Tap to retry.";
        addMessage(
          "An error occurred trying to start the microphone: " + e.message,
          "bot",
          null,
          new Date()
        );
      }
    }
  } else if (!recognition) {
    voiceStatusTextOverlay.textContent = "Speech API not available.";
    addMessage(
      "Web Speech API is not available in your browser.",
      "bot",
      null,
      new Date()
    );
  }
}

function stopListening() {
  if (recognition && isListening) {
    recognition.stop();
  }
}

// Function to set the AI's voice
function setAIVoice() {
  const voices = synth.getVoices();
  // Try to find a specific voice, e.g., a female voice, or one with a clear, standard accent.
  // You might need to inspect `voices` array in your browser's console to find suitable names.
  // Common names: 'Google US English', 'Microsoft Zira - English (United States)', 'Samantha' (iOS)
  selectedVoice =
    voices.find(
      (voice) =>
        voice.name.includes("Google US English") &&
        voice.lang === "en-US" &&
        voice.gender === "female"
    ) ||
    voices.find(
      (voice) => voice.name.includes("Zira") && voice.lang === "en-US"
    ) ||
    voices.find(
      (voice) => voice.lang === "en-US" && voice.name.includes("Female")
    ) ||
    voices.find((voice) => voice.lang === "en-US") ||
    voices[0]; // Fallback to the first available voice

  if (selectedVoice) {
    console.log("AI Voice selected:", selectedVoice.name, selectedVoice.lang);
  } else {
    console.warn("Could not find a specific AI voice, using default.");
  }
}

function speakText(text) {
  if (!isVoiceTalkActive || !synth || !selectedVoice) {
    console.warn(
      "Speech synthesis not active, synth not available, or no voice selected. Cannot speak."
    );
    return;
  }

  speechQueue.push(text); // Add text to the queue
  processSpeechQueue(); // Start/continue processing the queue
}

function processSpeechQueue() {
  if (isProcessingSpeechQueue || speechQueue.length === 0) {
    return; // Already processing or nothing to speak
  }

  isProcessingSpeechQueue = true;
  stopListening(); // Stop listening while AI is speaking

  const textToSpeak = speechQueue.shift(); // Get the next text from the queue
  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  utterance.lang = "en-US";
  utterance.pitch = 1.0; // Default pitch (0.1 to 2.0)
  utterance.rate = 1.0; // Default rate (0.1 to 10.0)
  utterance.voice = selectedVoice; // Apply the selected voice

  utterance.onstart = () => {
    isSpeaking = true;
    micControlBtn.classList.add("mic-active");
    micControlBtn.querySelector("i").className = "fas fa-volume-up"; // Speaking icon
    voiceStatusTextOverlay.textContent = "Speaking...";
    console.log("Speech synthesis started.");
    startVoiceVisualizer(true); // Start visualizer for AI speech (full screen overlay)
    showTalkingAnimation(); // Show subtle animation at bottom
  };

  utterance.onend = () => {
    console.log("Speech synthesis ended.");
    isSpeaking = false;
    stopVoiceVisualizer(); // Stop visualizer
    hideTalkingAnimation(); // Hide subtle animation
    isProcessingSpeechQueue = false; // Mark as done with current utterance

    if (speechQueue.length > 0) {
      processSpeechQueue(); // Process next in queue
    } else {
      // Only reset controls and restart listening if the entire queue is empty
      micControlBtn.classList.remove("mic-active");
      micControlBtn.querySelector("i").className = "fas fa-microphone"; // Default icon
      if (isVoiceTalkActive) {
        voiceStatusTextOverlay.textContent = "Standard voice"; // Reset status text
        startListening(); // Restart listening after AI finishes speaking
      }
    }
  };

  utterance.onerror = (event) => {
    console.error("Speech synthesis error:", event.error);
    isSpeaking = false;
    stopVoiceVisualizer(); // Stop visualizer
    hideTalkingAnimation(); // Hide subtle animation
    isProcessingSpeechQueue = false; // Mark as done with current utterance

    // Clear the rest of the queue on error to prevent cascading issues
    speechQueue = [];

    micControlBtn.classList.remove("mic-active");
    micControlBtn.querySelector("i").className = "fas fa-microphone"; // Default icon on error
    if (isVoiceTalkActive) {
      voiceStatusTextOverlay.textContent = "Speech error. Tap mic to retry."; // More informative error
      startListening(); // Try to restart listening
    }
  };

  synth.speak(utterance);
}

function stopSpeaking() {
  if (isSpeaking || isProcessingSpeechQueue) {
    synth.cancel(); // Stops current utterance
    speechQueue = []; // Clear any pending utterances
    isSpeaking = false;
    isProcessingSpeechQueue = false;
    micControlBtn.classList.remove("mic-active");
    micControlBtn.querySelector("i").className = "fas fa-microphone"; // Default icon
    stopVoiceVisualizer(); // Stop any ongoing visualizer
    hideTalkingAnimation(); // Ensure subtle animation is hidden
  }
}

// Web Audio API Visualizer Logic
async function initializeVoiceVisualizer() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn("getUserMedia not supported in this browser.");
    return;
  }

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048; // Fast Fourier Transform size
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength); // Array to hold frequency data

    canvas = document.getElementById("voice-circle-canvas");
    canvasCtx = canvas.getContext("2d");

    // Set canvas dimensions dynamically
    const setCanvasSize = () => {
      const size = Math.min(window.innerWidth, window.innerHeight) * 0.5; // Max 50% of smaller dimension
      canvas.width = size;
      canvas.height = size;
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height); // Clear after resize
    };
    setCanvasSize();
    window.addEventListener("resize", setCanvasSize);

    // Get microphone stream only once
    if (!microphoneStream) {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const source = audioContext.createMediaStreamSource(microphoneStream);
      source.connect(analyser);
      // analyser.connect(audioContext.destination); // Connect to speakers for monitoring, optional
    }
  } catch (err) {
    console.error("Error accessing microphone for visualizer:", err);
    // Disable voice features if mic access fails
    voiceTalkBtn.disabled = true;
    voiceTalkBtn.title = "Microphone access denied or not available.";
    micControlBtn.disabled = true;
    micControlBtn.title = "Microphone access denied or not available.";
    addMessage(
      "Microphone access is required for voice visualization and input. Please enable it in your browser settings.",
      "bot",
      null,
      new Date()
    );
  }
}

function startVoiceVisualizer(isAIVoice = false) {
  if (!analyser || !canvasCtx) return;

  cancelAnimationFrame(animationFrameId); // Stop any existing animation

  const draw = () => {
    animationFrameId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray); // Get frequency data

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const maxRadius = Math.min(centerX, centerY) * 0.7; // Max size

    // Calculate overall volume (amplitude)
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      sum += dataArray[i];
    }
    let average = sum / bufferLength;
    let normalizedVolume = average / 128; // Normalize to 0-2 range (can exceed 1 for loud sounds)
    normalizedVolume = Math.min(2, Math.max(0, normalizedVolume)); // Clamp between 0 and 2

    const baseCircleRadius = Math.min(centerX, centerY) * 0.4;
    const maxCircleExpansion = Math.min(centerX, centerY) * 0.3; // Max expansion beyond base

    // Dynamic properties based on AI voice or user voice
    const mainColor = isAIVoice ? "106, 13, 173" : "16, 163, 127"; // Accent vs Primary
    const numRings = isAIVoice ? 7 : 5; // More rings for AI
    const baseLineWidth = isAIVoice ? 3 : 2; // Thicker lines for AI
    const maxLineWidthBoost = isAIVoice ? 7 : 5; // More boost for AI

    // Add a subtle rotation for AI voice
    if (isAIVoice) {
      canvasCtx.save();
      canvasCtx.translate(centerX, centerY);
      canvasCtx.rotate((Date.now() * 0.001) % (2 * Math.PI)); // Faster continuous rotation for AI voice
      canvasCtx.translate(-centerX, -centerY);
    }

    for (let i = 0; i < numRings; i++) {
      const ringOffset = i * (maxCircleExpansion / numRings);
      let currentRadius =
        baseCircleRadius +
        normalizedVolume * maxCircleExpansion * 0.5 +
        ringOffset;

      // More dynamic animation for AI voice
      const animationFactor = isAIVoice
        ? Math.sin(Date.now() * 0.008 + i * 0.7) * 0.07
        : Math.sin(Date.now() * 0.005 + i * 0.5) * 0.05;
      currentRadius *= 1 + animationFactor;

      const opacity = 0.1 + normalizedVolume * 0.4 * (1 - i / numRings);
      const lineWidth =
        baseLineWidth +
        normalizedVolume * maxLineWidthBoost * (1 - i / numRings);

      canvasCtx.beginPath();
      canvasCtx.arc(centerX, centerY, currentRadius, 0, 2 * Math.PI);
      canvasCtx.strokeStyle = `rgba(${mainColor}, ${opacity})`;
      canvasCtx.lineWidth = lineWidth;
      canvasCtx.stroke();
    }

    // Draw a central solid circle that pulses more
    const centralRadius =
      baseCircleRadius * 0.8 + normalizedVolume * baseCircleRadius * 0.2;
    canvasCtx.beginPath();
    canvasCtx.arc(centerX, centerY, centralRadius, 0, 2 * Math.PI);
    canvasCtx.fillStyle = `rgba(${mainColor}, ${0.5 + normalizedVolume * 0.4})`; // More opaque for AI
    canvasCtx.fill();

    if (isAIVoice) {
      canvasCtx.restore(); // Restore canvas state after rotation
    }
  };
  draw();
}

function stopVoiceVisualizer() {
  cancelAnimationFrame(animationFrameId);
  if (canvasCtx) {
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas
  }
}

voiceTalkBtn.addEventListener("click", () => {
  isVoiceTalkActive = !isVoiceTalkActive;

  if (isVoiceTalkActive) {
    console.log("Voice Talk ON");
    voiceModeOverlay.classList.add("active"); // Show full-screen overlay
    mainContentElement.style.display = "none"; // Hide main chat UI
    voiceStatusTextOverlay.textContent = "Standard voice"; // Initial status for overlay
    startListening(); // Attempt to start listening
  } else {
    console.log("Voice Talk OFF");
    stopListening();
    stopSpeaking(); // Ensure all speech and visualizer are stopped
    stopVoiceVisualizer(); // Stop visualizer when exiting voice mode
    stopScreenShare(); // Stop screen share if active

    voiceModeOverlay.classList.remove("active"); // Hide full-screen overlay
    mainContentElement.style.display = "flex"; // Show main chat UI

    micControlBtn.classList.remove("mic-active"); // Reset mic button on overlay
    micControlBtn.querySelector("i").className = "fas fa-microphone";
  }
});

// Event listener for the mic button on the overlay
micControlBtn.addEventListener("click", () => {
  if (isListening) {
    stopListening();
    voiceStatusTextOverlay.textContent = "Tap mic to speak."; // Prompt user to tap again
  } else {
    startListening();
  }
});

// Event listener for the close button on the overlay
closeVoiceModeBtn.addEventListener("click", () => {
  isVoiceTalkActive = false; // Deactivate voice mode
  // Manually trigger the state change that voiceTalkBtn.click() would do
  stopListening();
  stopSpeaking();
  stopVoiceVisualizer();
  stopScreenShare(); // Stop screen share if active

  voiceModeOverlay.classList.remove("active");
  mainContentElement.style.display = "flex";
  micControlBtn.classList.remove("mic-active");
  micControlBtn.querySelector("i").className = "fas fa-microphone";
  showSendButton(); // Ensure send button is visible if not in voice mode
});

// NEW: Screen Share Functions
screenShareBtn.addEventListener("click", () => {
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});

async function startScreenShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    addMessage(
      "Screen sharing not supported in your browser.",
      "bot",
      null,
      new Date()
    );
    if (isVoiceTalkActive)
      speakText("Screen sharing not supported in your browser.");
    console.warn("getDisplayMedia not supported.");
    return;
  }

  try {
    // Request screen share stream
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    screenShareVideoElement.srcObject = screenShareStream;
    screenSharePreviewContainer.style.display = "flex"; // Show preview

    isScreenSharing = true;
    screenShareBtn.classList.add("screen-share-active");
    screenShareBtn.querySelector("i").className = "fas fa-stop-circle"; // Stop icon

    // Listen for when the user stops sharing directly from the browser's UI
    screenShareStream.getVideoTracks()[0].onended = () => {
      console.log("Screen share ended by user.");
      stopScreenShare();
    };

    // Start capturing and sending frames
    screenShareInterval = setInterval(captureAndSendScreenFrame, 2000); // Send frame every 2 seconds
    addMessage(
      "Screen sharing started. I will analyze your screen for issues.",
      "bot",
      null,
      new Date()
    );
    if (isVoiceTalkActive)
      speakText(
        "Screen sharing started. I will analyze your screen for issues."
      );
  } catch (err) {
    console.error("Error starting screen share:", err);
    addMessage(
      "Could not start screen sharing. Please ensure you grant permission.",
      "bot",
      null,
      new Date()
    );
    if (isVoiceTalkActive)
      speakText(
        "Could not start screen sharing. Please ensure you grant permission."
      );
    isScreenSharing = false;
    screenShareBtn.classList.remove("screen-share-active");
    screenShareBtn.querySelector("i").className = "fas fa-desktop";
    screenSharePreviewContainer.style.display = "none";
  }
}

function stopScreenShare() {
  if (screenShareStream) {
    screenShareStream.getTracks().forEach((track) => track.stop());
    screenShareStream = null;
  }
  if (screenShareInterval) {
    clearInterval(screenShareInterval);
    screenShareInterval = null;
  }
  isScreenSharing = false;
  screenShareBtn.classList.remove("screen-share-active");
  screenShareBtn.querySelector("i").className = "fas fa-desktop"; // Reset icon
  screenSharePreviewContainer.style.display = "none"; // Hide preview
  addMessage("Screen sharing stopped.", "bot", null, new Date());
  if (isVoiceTalkActive) speakText("Screen sharing stopped.");
}

async function captureAndSendScreenFrame() {
  if (!screenShareVideoElement || !isScreenSharing) return;

  // Set canvas dimensions to match video stream
  screenCaptureCanvas.width = screenShareVideoElement.videoWidth;
  screenCaptureCanvas.height = screenShareVideoElement.videoHeight;

  // Draw the current video frame onto the canvas
  screenCaptureCtx.drawImage(
    screenShareVideoElement,
    0,
    0,
    screenCaptureCanvas.width,
    screenCaptureCanvas.height
  );

  // Get base64 image data from the canvas
  const imageDataUrl = screenCaptureCanvas.toDataURL("image/jpeg", 0.7); // JPEG for compression, 70% quality
  const base64Image = imageDataUrl.split(",")[1]; // Remove "data:image/jpeg;base64," prefix

  try {
    const formData = new FormData();
    formData.append("image", base64Image);
    formData.append("chat_id", currentChatId);
    formData.append(
      "instruction",
      "Analyze this screenshot for any UI/code issues, errors, or areas for improvement. Suggest specific fixes or next steps, including code if applicable."
    );

    const response = await fetch(
      `${window.location.origin}/process_screen_frame`,
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await response.json();
    if (data && data.response) {
      addMessage(
        `**Screen Analysis:** ${data.response}`,
        "bot",
        null,
        new Date()
      );
      if (isVoiceTalkActive) speakText(data.response);
    } else {
      console.error("Screen analysis failed: No response from AI.");
    }
  } catch (error) {
    console.error("Error sending screen frame to AI:", error);
    // Optionally add a message to the chat about the error
  }
}

// NEW: Code Update Modal Functions
const codeUpdateModal = document.getElementById("codeUpdateModal");
const fileToUpdateSelect = document.getElementById("fileToUpdateSelect");
const codeUpdateTextarea = document.getElementById("codeUpdateTextarea");
const applyCodeUpdateBtn = document.getElementById("applyCodeUpdateBtn");

window.openCodeUpdateModal = function (suggestedCode = "", fileType = "html") {
  codeUpdateTextarea.value = suggestedCode;
  // Set the selected file type in the dropdown
  if (fileToUpdateSelect) {
    const options = Array.from(fileToUpdateSelect.options);
    const matchingOption = options.find((option) =>
      option.value.includes(fileType)
    );
    if (matchingOption) {
      fileToUpdateSelect.value = matchingOption.value;
    } else {
      fileToUpdateSelect.value = "index.html"; // Default
    }
  }
  codeUpdateModal.style.display = "flex";
};

applyCodeUpdateBtn.addEventListener("click", async () => {
  const fileName = fileToUpdateSelect.value;
  const fileContent = codeUpdateTextarea.value;

  if (!fileName || !fileContent) {
    addMessage(
      "Please select a file and provide content to update.",
      "bot",
      null,
      new Date()
    );
    return;
  }

  addMessage(`Attempting to update ${fileName}...`, "user", null, new Date());
  codeUpdateModal.style.display = "none"; // Hide modal immediately

  try {
    const formData = new FormData();
    formData.append("file_name", fileName);
    formData.append("file_content", fileContent);

    const response = await fetch(`${window.location.origin}/update_file`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();
    if (data.status === "success") {
      addMessage(
        `Successfully updated ${fileName}: ${data.message}`,
        "bot",
        null,
        new Date()
      );
    } else {
      addMessage(
        `Failed to update ${fileName}: ${data.message}`,
        "bot",
        null,
        new Date()
      );
    }
  } catch (error) {
    console.error("Error applying code update:", error);
    addMessage(
      `Error communicating with server for file update: ${error.message}`,
      "bot",
      null,
      new Date()
    );
  }
});

async function updateChatHistory() {
  const chatHistoryList = document.getElementById("chat-history-list");
  chatHistoryList.innerHTML = ""; // Clear existing history
  try {
    const response = await fetch(
      `${window.location.origin}/get_chat_history_list`
    );
    const chatSummaries = await response.json();

    if (chatSummaries.length === 0) {
      await startNewChat(true); // Start a new chat if no history
    } else {
      chatSummaries.forEach((chatSummary) => {
        const chatLink = document.createElement("a");
        chatLink.href = "#";
        chatLink.className = `chat-link ${
          chatSummary.id === currentChatId ? "active" : ""
        }`;
        chatLink.setAttribute("data-chat-id", chatSummary.id); // Store chat ID
        chatLink.setAttribute("data-chat-title", chatSummary.title); // Store chat title
        chatLink.setAttribute("role", "option");
        chatLink.setAttribute(
          "aria-selected",
          chatSummary.id === currentChatId ? "true" : "false"
        );
        chatLink.setAttribute("tabindex", "0"); // Make it focusable

        const chatTitleSpan = document.createElement("span");
        chatTitleSpan.textContent = chatSummary.title;
        chatLink.appendChild(chatTitleSpan);

        const actionsDiv = document.createElement("div");
        actionsDiv.className = "chat-link-actions";

        const renameBtn = document.createElement("button");
        renameBtn.className = "rename-chat-btn";
        renameBtn.innerHTML = '<i class="fas fa-edit" aria-hidden="true"></i>';
        renameBtn.title = "Rename Chat";
        renameBtn.setAttribute(
          "aria-label",
          `Rename chat ${chatSummary.title}`
        );
        renameBtn.onclick = (e) => {
          e.stopPropagation(); // Prevent loading chat when clicking rename
          renameChat(chatSummary.id, chatSummary.title);
        };
        actionsDiv.appendChild(renameBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-chat-btn";
        deleteBtn.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
        deleteBtn.title = "Delete Chat";
        deleteBtn.setAttribute(
          "aria-label",
          `Delete chat ${chatSummary.title}`
        );
        deleteBtn.onclick = (e) => {
          e.stopPropagation(); // Prevent loading chat when clicking delete
          deleteChat(chatSummary.id, chatSummary.title);
        };
        actionsDiv.appendChild(deleteBtn);

        chatLink.appendChild(actionsDiv);

        chatLink.onclick = (e) => {
          e.preventDefault();
          loadChat(chatSummary.id);
        };
        chatHistoryList.appendChild(chatLink);
      });

      // Load the most recent chat if no current chat is active
      const isCurrentChatInList = chatSummaries.some(
        (summary) => summary.id === currentChatId
      );
      if (!currentChatId || !isCurrentChatInList) {
        currentChatId = chatSummaries[0].id; // Load the first chat by default
        await loadChat(currentChatId);
      } else {
        await loadChat(currentChatId); // Reload current chat to update active state
      }
    }
  } catch (error) {
    console.error("Error fetching chat history list:", error);
    addMessage(
      "Failed to load chat history. Please try refreshing.",
      "bot",
      null,
      new Date()
    );
  }
}

async function loadChat(id) {
  const chatbox = document.getElementById("chatbox");
  const newChatPlaceholder = document.getElementById("new-chat-placeholder");
  currentChatId = id;
  chatbox.innerHTML = ""; // Clear chatbox before loading new chat

  try {
    const response = await fetch(
      `${window.location.origin}/get_chat_messages/${id}`
    );
    const chatData = await response.json();

    if (chatData.length === 0) {
      // If loading an empty chat, show the placeholder
      if (newChatPlaceholder) {
        newChatPlaceholder.style.display = "flex";
      } else {
        const placeholderDiv = document.createElement("div");
        placeholderDiv.id = "new-chat-placeholder";
        placeholderDiv.className = "new-chat-placeholder";
        placeholderDiv.innerHTML = `
    <img src="/static/images/vexara-new1-removebg-preview.png" alt="V" style="width: 60px; height: 60px;background-repeat: no-repeat;background-size: cover;" />
          <span style="color = var(--text-color); ">How can I help you?</span>
          
      `;
        chatbox.appendChild(placeholderDiv);
      }
    } else {
      // If there are messages, remove the placeholder if it exists
      if (newChatPlaceholder) {
        newChatPlaceholder.remove();
      }
      chatData.forEach((msg) => {
        const msgTimestamp = msg.timestamp
          ? new Date(msg.timestamp * 1000)
          : new Date();
        if (msg.type === "bot" && msg.image_urls && msg.image_urls.length > 0) {
          addMessage(msg.text, msg.type, msg.image_urls, msgTimestamp);
        } else if (msg.type === "user" && msg.image_url) {
          const imgElement = document.createElement("img");
          imgElement.src = msg.image_url;
          imgElement.classList.add("uploaded-image-preview");
          addMessage(msg.text, msg.type, imgElement, msgTimestamp);
        } else {
          addMessage(msg.text, msg.type, null, msgTimestamp);
        }
      });
    }

    // Update active state in chat history list
    document.querySelectorAll(".chat-link").forEach((link) => {
      link.classList.remove("active");
      link.setAttribute("aria-selected", "false");
    });
    const activeLink = document.querySelector(
      `.chat-link[data-chat-id="${currentChatId}"]`
    );
    if (activeLink) {
      activeLink.classList.add("active");
      activeLink.setAttribute("aria-selected", "true");
    }

    scrollToBottom();
  } catch (error) {
    console.error(`Error loading chat data for ${id}:`, error);
    addMessage(
      "Failed to load chat. It might have been deleted or corrupted.",
      "bot",
      null,
      new Date()
    );
  }
}

// NEW: Function to rename a chat
async function renameChat(chatId, currentTitle) {
  const newTitle = prompt(`Rename chat "${currentTitle}":`, currentTitle);
  if (newTitle && newTitle.trim() !== currentTitle) {
    try {
      const response = await fetch(
        `${window.location.origin}/rename_chat/${chatId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ new_title: newTitle.trim() }),
        }
      );
      const result = await response.json();
      if (result.status === "success") {
        addMessage(
          `Chat "${currentTitle}" renamed to "${newTitle}".`,
          "bot",
          null,
          new Date()
        );
        await updateChatHistory(); // Refresh the sidebar
      } else {
        addMessage(
          `Failed to rename chat: ${result.error}`,
          "bot",
          null,
          new Date()
        );
      }
    } catch (error) {
      console.error("Error renaming chat:", error);
      const userErrorMessage = error.message.includes("Failed to fetch")
        ? "Could not connect to the server. Please check your network connection and ensure the server is running."
        : `An unexpected network error occurred: ${error.message}.`;
      addMessage(
        `Network error while renaming chat: ${userErrorMessage} Please try again.`,
        "bot",
        null,
        new Date()
      );
    }
  } else if (newTitle !== null && newTitle.trim() === "") {
    addMessage("Chat title cannot be empty.", "bot", null, new Date());
  }
}

// NEW: Function to delete a chat
async function deleteChat(chatId, chatTitle) {
  // Use the existing confirm modal for deletion
  const confirmModal = document.getElementById("confirmModal");
  const modalTitle = confirmModal.querySelector("h3");
  const modalParagraph = confirmModal.querySelector("p");
  const confirmBtn = document.getElementById("confirmClearBtn");
  const cancelBtn = confirmModal.querySelector(".modal-btn.cancel");

  modalTitle.textContent = `Delete Chat "${chatTitle}"?`;
  modalParagraph.textContent = `Are you sure you want to delete "${chatTitle}"? This action cannot be undone.`;
  confirmBtn.textContent = "Delete";
  confirmBtn.classList.remove("confirm"); // Remove 'confirm' class for general clear all
  confirmBtn.classList.add("modal-btn", "confirm"); // Re-add for delete specific styling

  // Temporarily remove previous listener and add new one for this specific action
  const oldConfirmListener = confirmBtn.onclick;
  confirmBtn.onclick = null; // Clear existing listener
  confirmBtn.addEventListener(
    "click",
    async function handler() {
      try {
        const response = await fetch(
          `${window.location.origin}/delete_chat/${chatId}`,
          {
            method: "POST",
          }
        );
        const result = await response.json();
        if (result.status === "success") {
          addMessage(`Chat "${chatTitle}" deleted.`, "bot", null, new Date());
          if (chatId === currentChatId) {
            // If the current chat was deleted, start a new one
            await startNewChat();
          } else {
            await updateChatHistory(); // Refresh the sidebar
          }
        } else {
          addMessage(
            `Failed to delete chat: ${result.error}`,
            "bot",
            null,
            new Date()
          );
        }
      } catch (error) {
        console.error("Error deleting chat:", error);
        const userErrorMessage = error.message.includes("Failed to fetch")
          ? "Could not connect to the server. Please check your network connection and ensure the server is running."
          : `An unexpected network error occurred: ${error.message}.`;
        addMessage(
          `Network error while deleting chat: ${userErrorMessage} Please try again.`,
          "bot",
          null,
          new Date()
        );
      } finally {
        hideModal();
        // Restore original confirm button listener if needed, or just keep it null for next use
        confirmBtn.onclick = oldConfirmListener;
        confirmBtn.removeEventListener("click", handler); // Remove this specific handler
        // Reset modal text to default for clear all chats
        modalTitle.textContent = `Clear All Chats?`;
        modalParagraph.textContent = `Are you sure you want to clear all chat history? This action cannot be undone.`;
        confirmBtn.textContent = "Clear All";
        confirmBtn.classList.remove("confirm");
        confirmBtn.classList.add("modal-btn", "confirm");
      }
    },
    { once: true }
  ); // Use { once: true } to automatically remove listener after first execution

  if (confirmModal) confirmModal.style.display = "flex";
}

// Initialize the app on DOMContentLoaded
document.addEventListener("DOMContentLoaded", async function () {
  // Apply dark mode if previously enabled
  if (localStorage.getItem("darkMode") === "enabled") {
    document.body.classList.add("dark-mode");
  }

  // Highlight all existing code blocks on load
  hljs.highlightAll();

  // Initialize Speech Recognition and Visualizer
  initializeSpeechRecognition();
  initializeVoiceVisualizer();

  // Initialize Speech Synthesis Voices
  if ("SpeechSynthesisUtterance" in window && "speechSynthesis" in window) {
    synth = window.speechSynthesis;
    synth.onvoiceschanged = setAIVoice; // Listen for voices to be loaded
    setAIVoice(); // Call immediately in case voices are already loaded
  } else {
    console.warn("Web Speech Synthesis API not supported.");
    addMessage(
      "Your browser does not support Web Speech Synthesis (AI voice output). Please use a compatible browser like Chrome or Edge.",
      "bot",
      null,
      new Date()
    );
  }

  // Element References (re-get if needed due to new elements)
  const sidebar = document.getElementById("sidebar");
  const showSidebarBtn = document.getElementById("showSidebarBtn");
  const sidebarToggleButton = document.getElementById("sidebarToggleButton"); // Changed from hideSidebarBtn
  const textInput = document.getElementById("text-input");
  const multiActionForm = document.getElementById("multi-action-form");
  const cameraOptions = document.querySelector(".camera-options");
  const takePhotoInput = document.getElementById("take-photo-input"); // NEW: Get the actual input
  const uploadPhotoInput = document.getElementById("upload-photo-input"); // NEW: Get the actual input
  const desktopFileInput = document.getElementById("desktop-file-input"); // NEW: Get the desktop file input
  const cancelCameraBtn = document.getElementById("cancel-camera");
  const clearImageBtn = document.getElementById("clear-image-btn"); // Get clear image button
  const clearAllChatsBtn = document.getElementById("clearAllChatsBtn");
  const confirmClearBtn = document.getElementById("confirmClearBtn");
  const modal = document.getElementById("confirmModal");
  const webSearchBtn = document.getElementById("web-search-btn"); // Get the new web search button
  const sendBtn = document.getElementById("send-btn"); // Reference to the send button
  const stopBtn = document.getElementById("stop-btn"); // Reference to the stop button
  const attachFileBtn = document.getElementById("attach-file-btn"); // NEW: Get the attach file button

  // New: Get radio buttons for model selection
  const modelGeneralRadio = document.getElementById("modelGeneral");
  const modelDeepThinkRadio = document.getElementById("modelDeepThink");
  // Removed fileInputLabel as it's now attachFileBtn

  // Event Listeners for UI interaction
  // Use sidebarToggleButton for collapsing/expanding the sidebar from inside
  if (sidebarToggleButton)
    sidebarToggleButton.addEventListener("click", toggleSidebar);
  // Use showSidebarBtn for showing the sidebar when it's fully hidden (mobile or desktop full screen)
  if (showSidebarBtn) showSidebarBtn.addEventListener("click", toggleSidebar);

  if (clearImageBtn) clearImageBtn.addEventListener("click", clearImagePreview); // Event listener for clear image button
  if (stopBtn) {
    // NEW: Add event listener for the stop button
    stopBtn.addEventListener("click", function () {
      if (abortController) {
        abortController.abort(); // Abort the ongoing fetch request
      }
      showSendButton(); // Immediately show send button
      document.getElementById("loader").style.display = "none"; // Hide loader
      stopSpeaking(); // Stop any ongoing speech
    });
  }

  // Responsive window resize handling
  window.addEventListener("resize", () => {
    // Adjust sidebar and main content behavior on resize
    const mainContent = document.querySelector(".main");
    if (window.innerWidth <= 768) {
      // On mobile, ensure sidebar is not 'collapsed' but rather 'visible' for slide-out
      if (sidebar.classList.contains("collapsed")) {
        sidebar.classList.remove("collapsed");
        mainContent.classList.remove("full-width");
      }
    } else {
      // On desktop, hide floating button if sidebar is open
      // Restore sidebar visibility based on previous state if on desktop
      if (!sidebarHidden) {
        // Only if not manually hidden
        sidebar.classList.remove("collapsed");
        mainContent.classList.remove("full-width");
      }
    }
    updateSidebarToggleButtonVisibility(); // Always call this on resize to ensure correct button state
  });

  // Auto-resize textarea based on content
  if (textInput) {
    textInput.addEventListener("input", () => {
      textInput.style.height = "auto"; // Reset height
      textInput.style.height = textInput.scrollHeight + "px"; // Set to scroll height
      // Toggle active class for send button based on text input
      if (textInput.value.trim().length > 0) {
        sendBtn.classList.add("active");
      } else {
        sendBtn.classList.remove("active");
      }
    });

    // NEW: Handle Enter key to send message
    textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); // Prevent new line
        multiActionForm.dispatchEvent(
          new Event("submit", { cancelable: true })
        ); // Trigger form submission
      }
    });
  }

  // Handle web search button click
  if (webSearchBtn) {
    webSearchBtn.addEventListener("click", async function () {
      const userText = textInput.value.trim();
      if (!userText) {
        console.error("Please enter a search query.");
        addMessage("Please enter a search query.", "bot", null, new Date());
        if (isVoiceTalkActive) speakText("Please enter a search query.");
        return;
      }
      // Add user message immediately
      addMessage(
        `Searching the web for: "${userText}"`,
        "user",
        null,
        new Date()
      );

      const loaderElement = document.getElementById("loader");
      loaderElement.style.display = "block"; // Show loader
      showStopButton(); // Show stop button
      stopSpeaking(); // Stop AI speech if any

      try {
        // Call askAI with the web_search flag set to true
        const modelChoice = document.querySelector(
          'input[name="modelChoice"]:checked'
        ).value;
        await askAI(userText, modelChoice, true); // Pass true for performSearch
      } catch (error) {
        console.error("Web search button error:", error);
        addMessage(
          "Sorry, an unexpected error occurred during web search. Please try again.",
          "bot",
          null,
          new Date()
        );
        if (isVoiceTalkActive)
          speakText(
            "Sorry, an unexpected error occurred during web search. Please try again."
          );
      } finally {
        loaderElement.style.display = "none"; // Hide loader
        textInput.value = "";
        textInput.style.height = "auto";
        textInput.focus();
        sendBtn.classList.remove("active"); // Remove active class after sending
        showSendButton(); // Show send button
      }
    });
  }

  // Camera options for mobile (take photo/upload from gallery)
  // Show camera options when the attach file button is clicked on mobile
  if (attachFileBtn) {
    // NEW: Use attachFileBtn
    attachFileBtn.addEventListener("click", function (event) {
      if (window.innerWidth <= 768) {
        event.preventDefault(); // Prevent default button behavior on mobile if we're showing a modal first
        cameraOptions.style.display = "block";
      } else {
        // On desktop, directly trigger the hidden file input
        desktopFileInput.click();
      }
    });
  }

  // NEW: Event listeners for the actual hidden file inputs (mobile)
  if (takePhotoInput) {
    takePhotoInput.addEventListener("change", function () {
      if (this.files.length > 0) {
        showImagePreview(this.files[0]);
      }
      cameraOptions.style.display = "none"; // Always hide options once file selection attempt is done
    });
  }

  if (uploadPhotoInput) {
    uploadPhotoInput.addEventListener("change", function () {
      if (this.files.length > 0) {
        showImagePreview(this.files[0]);
      }
      cameraOptions.style.display = "none"; // Always hide options once file selection attempt is done
    });
  }

  // NEW: Event listener for the desktop file input
  // This listener is still needed even if the input is clicked programmatically
  if (desktopFileInput) {
    desktopFileInput.addEventListener("change", function () {
      if (this.files.length > 0) {
        showImagePreview(this.files[0]);
      } else {
        clearImagePreview(); // Clear preview if user cancels desktop file picker
      }
    });
  }

  if (cancelCameraBtn) {
    cancelCameraBtn.addEventListener("click", function () {
      if (cameraOptions) cameraOptions.style.display = "none";
      clearImagePreview(); // Clear preview on cancel
    });
  }

  // Handle form submission based on input content and attached files
  if (multiActionForm) {
    multiActionForm.addEventListener("submit", async function (e) {
      e.preventDefault(); // Prevent default form submission
      const loaderElement = document.getElementById("loader");
      loaderElement.style.display = "block"; // Show loader for all submission types
      showStopButton(); // Show stop button on submit
      stopSpeaking(); // Stop AI speech if any

      const userText = textInput.value.trim();
      const modelChoice = document.querySelector(
        'input[name="modelChoice"]:checked'
      ).value; // Get selected model

      // Determine which file input (if any) has a file
      let selectedFile = null;
      if (takePhotoInput && takePhotoInput.files.length > 0) {
        selectedFile = takePhotoInput.files[0];
      } else if (uploadPhotoInput && uploadPhotoInput.files.length > 0) {
        selectedFile = uploadPhotoInput.files[0];
      } else if (desktopFileInput && desktopFileInput.files.length > 0) {
        // NEW: Check desktop input
        selectedFile = desktopFileInput.files[0];
      }
      const hasFile = selectedFile !== null;

      try {
        if (hasFile) {
          // Assume image upload if a file is present
          // Add user message with image preview immediately (optimistic update)
          const imgElementForChat = document.createElement("img");
          imgElementForChat.src = document.getElementById("image-preview").src;
          imgElementForChat.classList.add("uploaded-image-preview");
          const caption = userText
            ? `Image with caption: "${userText}"`
            : "Uploaded image";
          addMessage(caption, "user", imgElementForChat, new Date());

          // Now call the function that handles backend interaction
          await uploadImage(selectedFile, userText);
        } else {
          // Check for special commands
          const lowerCaseText = userText.toLowerCase();

          if (
            lowerCaseText.startsWith("generate image of") ||
            lowerCaseText.startsWith("create an image of") ||
            lowerCaseText.startsWith("picture of") ||
            lowerCaseText.startsWith("draw a") ||
            lowerCaseText.startsWith("make an image of")
          ) {
            addMessage(userText, "user", null, new Date()); // Add user text message immediately
            await generateImage(userText);
          } else if (lowerCaseText.startsWith("explain code")) {
            addMessage(userText, "user", null, new Date());
            await explainCode(userText.replace("explain code", "").trim());
          } else if (lowerCaseText.startsWith("grammar check")) {
            addMessage(userText, "user", null, new Date());
            await checkGrammarAndStyle(
              userText.replace("grammar check", "").trim()
            );
          } else if (
            lowerCaseText.startsWith("show html code") ||
            lowerCaseText.startsWith("show app html")
          ) {
            addMessage(
              "Requesting application HTML code...",
              "user",
              null,
              new Date()
            );
            const response = await fetch(
              `${window.location.origin}/get_app_html`
            );
            const htmlCode = await response.text();

            loaderElement.style.display = "none";
            showSendButton();

            addMessage(
              "Here is the current HTML code for the AI Assistant app:",
              "bot",
              null,
              new Date()
            );
            const codeMessage = document.createElement("div");
            codeMessage.className = `chat-message bot-message pulse`;
            const codeContentDiv = document.createElement("div");
            codeContentDiv.className = "message-content";
            codeContentDiv.innerHTML = marked.parse(
              `\`\`\`html\n${htmlCode}\n\`\`\``
            );
            codeMessage.appendChild(codeContentDiv);
            document.getElementById("chatbox").appendChild(codeMessage);
            scrollToBottom();
            hljs.highlightAll();

            if (isVoiceTalkActive)
              speakText(
                "Here is the current HTML code for the AI Assistant app."
              );
          } else if (!userText) {
            console.error("Please enter your input.");
            addMessage("Please enter your input.", "bot", null, new Date());
            if (isVoiceTalkActive) speakText("Please enter your input.");
            return;
          } else {
            // Default to Ask AI
            addMessage(userText, "user", null, new Date()); // Add user text message immediately
            await askAI(userText, modelChoice); // Pass modelChoice
          }
        }
      } catch (error) {
        console.error("Submission error:", error);
        addMessage(
          "Sorry, an unexpected error occurred. Please try again.",
          "bot",
          null,
          new Date()
        );
        if (isVoiceTalkActive)
          speakText("Sorry, an unexpected error occurred. Please try again.");
      } finally {
        loaderElement.style.display = "none";
        textInput.value = "";
        textInput.style.height = "auto";
        textInput.focus();
        clearImagePreview();
        sendBtn.classList.remove("active"); // Remove active class after sending
        showSendButton(); // Ensure send button is shown after any submission type
      }
    });
  }

  // Clear all chats confirmation and action
  if (clearAllChatsBtn) {
    clearAllChatsBtn.addEventListener("click", function () {
      // Reset modal to "Clear All Chats" default before showing
      const modalTitle = modal.querySelector("h3");
      const modalParagraph = modal.querySelector("p");
      const confirmBtn = document.getElementById("confirmClearBtn");

      modalTitle.textContent = `Clear All Chats?`;
      modalParagraph.textContent = `Are you sure you want to clear all chat history? This action cannot be undone.`;
      confirmBtn.textContent = "Clear All";
      confirmBtn.classList.remove("confirm"); // Ensure it has default confirm styling
      confirmBtn.classList.add("modal-btn", "confirm");

      // Remove any previous specific delete handler and add the general clear all handler
      confirmBtn.onclick = null; // Clear previous listeners
      confirmBtn.addEventListener(
        "click",
        async function handler() {
          try {
            const response = await fetch(`/clear_all_chats`, {
              method: "POST",
            });
            const result = await response.json();

            if (result.status === "success") {
              currentChatId = null; // Reset current chat ID
              document.getElementById("chatbox").innerHTML = ""; // Clear chat messages
              // Add the new chat placeholder back
              const chatbox = document.getElementById("chatbox");
              const placeholderDiv = document.createElement("div");
              placeholderDiv.id = "new-chat-placeholder";
              placeholderDiv.className = "new-chat-placeholder";
              placeholderDiv.innerHTML = `
                  <img src="/static/images/vexara-new1-removebg-preview.png" alt="V" style="width: 60px; height: 60px;background-repeat: no-repeat;background-size: cover;" />
       <span>How can I help you?</span>
                  
              `;
              chatbox.appendChild(placeholderDiv);

              addMessage(
                "All chat history cleared. How can I help you?",
                "bot",
                null,
                new Date()
              );
              if (isVoiceTalkActive)
                speakText("All chat history cleared. How can I help you.");
              await updateChatHistory(); // Refresh sidebar history
              if (modal) modal.style.display = "none";
            } else {
              console.error(
                "Failed to clear chats:",
                result.error || "Unknown error."
              );
              addMessage(
                "Failed to clear chats. Please try again.",
                "bot",
                null,
                new Date()
              );
              if (isVoiceTalkActive)
                speakText("Failed to clear chats. Please try again.");
            }
          } catch (error) {
            console.error("Network error while clearing chats:", error);
            addMessage(
              "Network error while clearing chats. Please try again.",
              "bot",
              null,
              new Date()
            );
            if (isVoiceTalkActive)
              speakText(
                "Network error while clearing chats. Please try again."
              );
          } finally {
            if (modal) modal.style.display = "none";
            confirmBtn.removeEventListener("click", handler); // Remove this specific handler
          }
        },
        { once: true }
      ); // Use { once: true } to automatically remove listener after first execution

      if (modal) modal.style.display = "flex";
    });
  }

  // Initial setup on page load
  await updateChatHistory(); // Load existing chat history or start new chat

  // Fetch user info (assuming a /user_info endpoint)
  fetch("/user_info")
    .then((response) => response.json())
    .then((data) => {
      const userInfoDiv = document.getElementById("user-info");
      const userEmailSpan = document.getElementById("user-email");
      if (data.user_email) {
        userEmailSpan.textContent = data.user_email;
        userInfoDiv.style.display = "flex"; // Show user info if email exists
      } else {
        userInfoDiv.style.display = "none";
      }
    })
    .catch((error) => console.error("Error fetching user info:", error));

  // Initial desktop sidebar state
  if (window.innerWidth > 768) {
    sidebar.classList.remove("collapsed");
    mainContentElement.classList.remove("full-width");
    sidebarHidden = false; // Sidebar starts open
  }
  updateSidebarToggleButtonVisibility(); // Set initial button visibility correctly
});

// Demo: Show animation during speech synthesis
// This function is for demonstration purposes and uses the new show/hide functions.
function speakWithAnimation(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onstart = () => {
    showTalkingAnimation();
    // If you also want the full canvas visualizer for this demo:
    // startVoiceVisualizer(true);
  };
  utterance.onend = () => {
    hideTalkingAnimation();
    // If you were using the full canvas visualizer for this demo:
    // stopVoiceVisualizer();
  };
  utterance.onerror = () => {
    hideTalkingAnimation();
    // If you were using the full canvas visualizer for this demo:
    // stopVoiceVisualizer();
  };
  speechSynthesis.speak(utterance);
}

// let mod = document.getElementById("options-menu-btn");
// mod.addEventListener("click", function (e) {
//   e.preventDefault();
//   alert("btn clicked");
// });


// Handle + menu toggle
const plusMenuBtn = document.getElementById("plus-menu-btn");
const plusMenuContent = document.getElementById("plus-menu-content");

if (plusMenuBtn && plusMenuContent) {
  plusMenuBtn.addEventListener("click", () => {
    const isOpen = plusMenuContent.style.display === "block";
    plusMenuContent.style.display = isOpen ? "none" : "block";
    plusMenuBtn.setAttribute("aria-expanded", !isOpen);
  });

  // Close menu if clicking outside
  document.addEventListener("click", (e) => {
    if (!plusMenuBtn.contains(e.target) && !plusMenuContent.contains(e.target)) {
      plusMenuContent.style.display = "none";
      plusMenuBtn.setAttribute("aria-expanded", "false");
    }
  });
}

// Attach file button
const attachFileBtn = document.getElementById("attach-file-btn");
const desktopFileInput = document.getElementById("desktop-file-input");

if (attachFileBtn && desktopFileInput) {
  attachFileBtn.addEventListener("click", () => desktopFileInput.click());
  desktopFileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      console.log("Selected file:", e.target.files[0]);
      // 🔧 Your existing function for uploading/previewing files:
      // handleFileUpload(e.target.files[0]);
    }
  });
}

// Web Search button
const webSearchBtn = document.getElementById("web-search-btn");
if (webSearchBtn) {
  webSearchBtn.addEventListener("click", () => {
    console.log("Performing web search...");
    // 🔧 Replace with your existing web search function:
    // performWebSearch();
  });
}

// Deep Think radio
const deepThinkRadio = document.getElementById("modelDeepThink");
if (deepThinkRadio) {
  deepThinkRadio.addEventListener("change", () => {
    if (deepThinkRadio.checked) {
      console.log("Deep Think mode selected");
      // 🔧 Call your existing model switch logic:
      // setModel("deep_think");
    }
  });
}
// Function to add a thinking message to the chat
function addThinkingMessage() {
  const chatContainer = document.getElementById("chat-container");
  const thinkingMessage = document.createElement("div");
  thinkingMessage.className = "bot-message thinking-message";
  thinkingMessage.innerHTML = `
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
  `;
  chatContainer.appendChild(thinkingMessage);
  scrollToBottom();
  return thinkingMessage;
}
// Fix: Ensure the correct button state (Send visible, Stop hidden) on initial page load
document.addEventListener('DOMContentLoaded', () => {
  // Check if the function exists before calling it (for safety)
  if (typeof window.showSendButton === 'function') {
      window.showSendButton();
  }
});
// ==========================================================
// START: Code for Voice Talk/Submit Button Toggle and Fixes
// ==========================================================

// Function to manage the visibility of the Voice Talk and Send buttons
// This runs when the user types or when a response finishes.
function updateInputButtonState() {
    // Check if the required elements exist before proceeding
    const textInput = document.getElementById("text-input");
    const sendBtn = document.getElementById("send-btn");
    const voiceTalkBtn = document.getElementById("voice-talk-btn");
    const stopBtn = document.getElementById("stop-btn");

    if (!textInput || !sendBtn || !voiceTalkBtn || !stopBtn) return;

    // We assume the stop button is only visible when a response is generating.
    const isResponseGenerating = stopBtn.style.display !== "none";

    // If the AI is busy or Voice Talk is active, do not change the button state.
    if (isResponseGenerating || window.isVoiceTalkActive) {
        return;
    }

    // Check if the input field is empty (trimmed)
    if (textInput.value.trim().length === 0) {
        // Input is empty: Show Voice Talk, Hide Send
        voiceTalkBtn.style.display = "flex";
        sendBtn.style.display = "none";
    } else {
        // Input has text: Hide Voice Talk, Show Send
        voiceTalkBtn.style.display = "none";
        sendBtn.style.display = "flex";
    }
}

// Attach the new function to the input field so it updates dynamically as the user types
const textInput = document.getElementById("text-input");
if (textInput) {
    textInput.addEventListener("input", updateInputButtonState);
}


// IMPORTANT: You must MODIFY your existing showSendButton function, 
// DO NOT duplicate it. If you cannot modify it, ensure this code
// overwrites the old one if it's placed later in the file.
// This new version calls updateInputButtonState() to show the correct button.
window.showSendButton = function() {
    if (window.isVoiceTalkActive) return;
    document.getElementById("stop-btn").style.display = "none";
    
    // Determine whether to show Send or Voice Talk based on input content
    updateInputButtonState(); 
}


// Page Load Fix: Ensures the correct button state (Voice Talk visible if empty)
// is set when the page loads, resolving the initial "Stop Response" button issue.
document.addEventListener('DOMContentLoaded', () => {
    // Set the initial button state (shows Voice Talk if input is empty)
    if (typeof updateInputButtonState === 'function') {
        updateInputButtonState();
    }
});

// ==========================================================
// END: Code for Voice Talk/Submit Button Toggle and Fixes
// ==========================================================
// ==========================================================
// START: Code for Copy and Edit Functionality
// ==========================================================

// Global state to manage Read Aloud functionality
let currentSpeechUtterance = null;
let currentSpeechButton = null;

// Inline SVG for speaker (Play icon)
const speakerSVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"></path></svg>';

// Inline SVG for stop (Stop icon)
const stopSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-stop-circle" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h3A1.5 1.5 0 0 1 11 6.5v3A1.5 1.5 0 0 1 9.5 11h-3A1.5 1.5 0 0 1 5 9.5z"/></svg>';

// Helper to reset the read aloud button visual state
function resetReadAloudButton(button) {
  button.innerHTML = speakerSVG;
  button.title = 'Read aloud';
  button.setAttribute('aria-label', 'Read message aloud');
  button.style.color = 'var(--text-color)';
}

// Function to stop all ongoing speech
function stopSpeaking() {
  if (window.speechSynthesis && speechSynthesis.speaking) {
    speechSynthesis.cancel();
  }
  // Reset the button visual state if speech was canceled
  if (currentSpeechButton) {
    resetReadAloudButton(currentSpeechButton);
    currentSpeechUtterance = null;
    currentSpeechButton = null;
  }
}

// Function to read the message content aloud
function readMessageAloud(button) {
  if (!('speechSynthesis' in window)) {
    console.error('Web Speech API is not supported in this browser.');
    // Simple visual feedback if not supported
    button.innerHTML = '<span style="color: red; font-size: 10px;">X</span>';
    setTimeout(() => {
        resetReadAloudButton(button);
    }, 2000);
    return;
  }

  const messageWrapper = button.closest('.chat-message');
  const contentElement = messageWrapper ? messageWrapper.querySelector('.message-content') : null;
  
  if (!contentElement) {
    console.error('Message content element not found.');
    return;
  }

  const textToSpeak = contentElement.innerText;

  // 1. Check if the current button is the one already speaking (toggle stop)
  if (currentSpeechButton === button) {
    stopSpeaking(); // This will also reset the button
    return;
  }

  // 2. Stop any existing speech from other buttons
  if (speechSynthesis.speaking) {
    stopSpeaking();
  }

  // 3. Start new speech
  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  
  utterance.onstart = () => {
    // Set button state to active (stop icon)
    button.innerHTML = stopSVG;
    button.title = 'Stop reading';
    button.setAttribute('aria-label', 'Stop reading aloud');
    button.style.color = 'var(--text-color, #10b981)'; // Highlight active state
    currentSpeechButton = button;
    currentSpeechUtterance = utterance;
  };

  utterance.onend = () => {
    // Reset button state
    if (currentSpeechButton === button) {
      resetReadAloudButton(button);
      currentSpeechButton = null;
      currentSpeechUtterance = null;
    }
  };

  utterance.onerror = (event) => {
    console.error('Speech synthesis error:', event.error);
    if (currentSpeechButton === button) {
      resetReadAloudButton(button);
      currentSpeechButton = null;
      currentSpeechUtterance = null;
    }
  };

  // Speak the text
  speechSynthesis.speak(utterance);
}


// Function to copy text content to clipboard
function copyMessageContent(button) {
  const messageWrapper = button.closest('.chat-message');
  if (!messageWrapper) return;

  const contentElement = messageWrapper.querySelector('.message-content');
  if (!contentElement) return;

  const textToCopy = contentElement.innerText;

  // Use the modern Clipboard API if available
  if (navigator.clipboard) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      // Success feedback
      const originalHTML = button.innerHTML;
      button.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(() => {
        button.innerHTML = originalHTML;
      }, 1000);
    }).catch(err => {
      console.error('Copy failed with Clipboard API:', err);
      // Fallback to old method if Clipboard API fails (or for older browsers)
      fallbackCopyTextToClipboard(textToCopy, button);
    });
  } else {
    // Fallback for older browsers
    fallbackCopyTextToClipboard(textToCopy, button);
  }
}

// Fallback function for copying text
function fallbackCopyTextToClipboard(textToCopy, button) {
    const tempTextArea = document.createElement('textarea');
    tempTextArea.value = textToCopy;
    tempTextArea.style.position = 'fixed';
    tempTextArea.style.left = '-9999px';
    document.body.appendChild(tempTextArea);
    tempTextArea.focus();
    tempTextArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            const originalHTML = button.innerHTML;
            button.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => {
                button.innerHTML = originalHTML;
            }, 1000);
        }
    } catch (err) {
        console.error('Copy failed with execCommand:', err);
    } finally {
        document.body.removeChild(tempTextArea);
    }
}
// Function to regenerate AI answer
async function askAI(instruction, modelChoice, performSearch = false, isRegenerate = false) {
  const textInput = document.getElementById("text-input");
  const loader = document.getElementById("loader");

  // Show loader BEFORE creating the streaming message
  loader.style.display = "block";
  showStopButton(); // Show stop button, hide send button
  stopSpeaking(); // Stop AI speech if any

  // Initialize AbortController for this request
  let abortController = new AbortController();
  const signal = abortController.signal;

  try {
    const formData = new FormData();
    
    // If it's a regenerate request, add cache-busting parameter
    const finalInstruction = isRegenerate ? 
      `${instruction} [regenerate:${Date.now()}]` : 
      instruction;
    
    formData.append("instruction", finalInstruction);
    formData.append("chat_id", currentChatId);
    formData.append("model_choice", modelChoice);
    formData.append("web_search", performSearch);

    const response = await fetch(`${window.location.origin}/ask`, {
      method: "POST",
      body: formData,
      signal: signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Server error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Hide loader once the actual streaming starts
    loader.style.display = "none";

    // Create the initial message container for streaming
    createStreamingBotMessage(new Date());

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        await appendToStreamingBotMessage(chunk);
      }
    }

    // Finalize the streaming message after stream finishes
    finalizeStreamingBotMessage();
  } catch (error) {
    loader.style.display = "none";
    if (error.name === "AbortError") {
      console.log("Fetch aborted by user.");
      if (currentBotMessageContentDiv) {
        currentBotMessageContentDiv.innerHTML += `<p>*(Response stopped by user)*</p>`;
      } else {
        addMessage(`Response stopped by user.`, "bot", null, new Date());
      }
    } else {
      console.error("Error asking AI:", error);
      if (currentBotMessageContentDiv) {
        currentBotMessageContentDiv.innerHTML += `<p>Error: ${error.message}</p>`;
      } else {
        addMessage(
          `Sorry, there was an error processing your request: ${error.message}. Please try again.`,
          "bot",
          null,
          new Date()
        );
      }
    }
    finalizeStreamingBotMessage();
  } finally {
    textInput.value = "";
    textInput.style.height = "auto";
    textInput.focus();
    showSendButton();
    // Reset abortController after potential use
    if (typeof abortController !== 'undefined') {
        // Assuming abortController is defined in a scope accessible by showStopButton/showSendButton context
        // This is a common pattern in the larger chat script, so we'll assume the original context handles this.
    }
  }
}
// Function to regenerate AI answer
function regenerateAnswer(button) {
  const messageWrapper = button.closest('.chat-message');
  if (!messageWrapper || !messageWrapper.classList.contains('bot-message')) return;

  // Find the previous user message
  const allMessages = Array.from(document.querySelectorAll('.chat-message'));
  const currentMessageIndex = allMessages.indexOf(messageWrapper);
  
  if (currentMessageIndex === -1 || currentMessageIndex === 0) return;
  
  // Look backwards for the most recent user message
  let userMessage = null;
  for (let i = currentMessageIndex - 1; i >= 0; i--) {
    if (allMessages[i].classList.contains('user-message')) {
      userMessage = allMessages[i];
      break;
    }
  }
  
  if (!userMessage) return;
  
  // Get the user's original text
  const userContent = userMessage.querySelector('.message-content');
  if (!userContent) return;
  
  const originalText = userContent.innerText.trim();
  
  if (!originalText) {
    console.error('No original user message text found for regeneration');
    return;
  }

  // Show loading state on the regenerate button
  const originalHTML = button.innerHTML;
  button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  button.disabled = true;

  // Get the current model choice
  const modelChoiceInput = document.querySelector('input[name="modelChoice"]:checked');
  const modelChoice = modelChoiceInput ? modelChoiceInput.value : 'default';

  // Remove the current bot message that we're regenerating
  messageWrapper.remove();

  // Add the user message again to maintain context
  if (typeof addMessage === 'function') addMessage(originalText, "user", null, new Date());

  // Call askAI with regenerate flag set to true
  askAI(originalText, modelChoice, false, true)
    .finally(() => {
      // Restore the regenerate button (though it might be rebuilt if message actions are re-run)
      // This part might not execute if the new message is successfully generated before
      // this finally block runs, but it's kept for robustness.
      if (button.parentNode) {
          button.innerHTML = originalHTML;
          button.disabled = false;
      }
    });
}


// Function to edit user message
function editUserMessage(button) {
  const messageWrapper = button.closest('.chat-message');
  if (!messageWrapper || !messageWrapper.classList.contains('user-message')) return;

  const contentElement = messageWrapper.querySelector('.message-content');
  if (!contentElement) return;

  const currentText = contentElement.innerText.trim();
  const actionsContainer = messageWrapper.querySelector('.message-actions');

  if (actionsContainer) actionsContainer.style.display = 'none';
  contentElement.style.display = 'none';

  // --- Controls Container ---
  const editWrapper = document.createElement('div');
  editWrapper.className = 'message-edit-wrapper';
  editWrapper.style.cssText = `
    padding: 20px;
    border-radius: 12px; 
    background-color: var(--bg-color, #202020);
    margin: 10px 0;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-height: 120px;
    position: relative;
  `;

  // --- Text Area ---
  const editArea = document.createElement('textarea');
  editArea.style.cssText = `
    width: 100%; 
    height: auto; /* Auto height */
    min-height: 80px; /* Start taller */
    padding: 10px 0;
    border: none;
    border-radius: 0; 
    color: var(--text-color);
    background-color: var(--bg-color);
    box-sizing: border-box;
    font: inherit;
    resize: none;
    flex-grow: 1;
    outline: none; /* Removes blue outline */
    box-shadow: none; /* Ensures no blue glow */
    font-size: 16px; 
    line-height: 1.5;
    margin-bottom: 5px;
  `;
  editArea.value = currentText;
  // --- Controls (Cancel/Send) ---
  const controls = document.createElement('div');
  // Position the controls at the bottom right corner
  controls.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; align-items: flex-end; padding-top: 10px;';
  
  // --- Cancel Button (Themed like the image) ---
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  // *** STYLING MATCHING IMAGE ***
  cancelBtn.style.cssText = `
    padding: 8px 18px; 
    background: #363636; /* Dark background */
    color: white; 
    border: none; 
    border-radius: 18px; /* Pill shape */
    cursor: pointer;
    font-weight: 500;
    transition: background-color 0.2s;
  `;
  cancelBtn.onmouseover = () => cancelBtn.style.backgroundColor = '#4a4a4a';
  cancelBtn.onmouseout = () => cancelBtn.style.backgroundColor = '#363636';

  // --- Save & Resend Button (Themed like the image) ---
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Send';
  // *** STYLING MATCHING IMAGE ***
  saveBtn.style.cssText = `
    padding: 8px 18px; 
    background: white; /* Light background */
    color: #202020; /* Dark text */
    border: none; 
    border-radius: 18px; 
    cursor: pointer;
    font-weight: 600;
    transition: background-color 0.2s;
  `;
  saveBtn.onmouseover = () => saveBtn.style.backgroundColor = '#f0f0f0';
  saveBtn.onmouseout = () => saveBtn.style.backgroundColor = 'white';


  controls.appendChild(cancelBtn);
  controls.appendChild(saveBtn);

  editWrapper.appendChild(editArea);
  editWrapper.appendChild(controls);

  contentElement.parentNode.insertBefore(editWrapper, contentElement.nextSibling);

  editArea.focus();

  cancelBtn.onclick = () => {
    contentElement.style.display = 'block';
    if (actionsContainer) actionsContainer.style.display = 'flex';
    editWrapper.remove();
  };

  saveBtn.onclick = () => {
    const newText = editArea.value.trim();
    if (newText && newText !== currentText) {
      if (typeof marked !== 'undefined') {
        contentElement.innerHTML = marked.parse(newText);
      } else {
        contentElement.innerText = newText;
      }
      
      contentElement.style.display = 'block';
      if (actionsContainer) actionsContainer.style.display = 'flex';
      editWrapper.remove();

      const modelChoiceInput = document.querySelector('input[name="modelChoice"]:checked');
      const modelChoice = modelChoiceInput ? modelChoiceInput.value : 'default';

      // Assuming these functions exist to handle chat logic
      if (typeof addMessage === 'function') addMessage(newText, "user", null, new Date());
      if (typeof askAI === 'function') askAI(newText, modelChoice);
    } else {
      cancelBtn.onclick();
    }
  };
}

// Function to add action buttons to messages
function addMessageActions(messageElement) {
  if (messageElement.querySelector('.message-actions')) return;

  const isBot = messageElement.classList.contains('bot-message');
  const isUser = messageElement.classList.contains('user-message');
  if (!isBot && !isUser) return;

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'message-actions';

  // Styling based on message type
  if (isUser) {
    actionsContainer.style.cssText = 'display: flex; gap: 5px; justify-content: flex-end; margin-top: 5px; margin-left: 10px;';
  } else {
    actionsContainer.style.cssText = 'display: flex; gap: 5px; justify-content: flex-start; margin-top: 5px; margin-right: 10px;';
  }

  // --- Shared Button Styling ---
  const buttonStyle = `
    background: none; 
    border: none; 
    cursor: pointer; 
    padding: 5px; 
    border-radius: 3px;
    color: var(--text-color); /* Use a light gray for inactive buttons */
    transition: color 0.2s;
  `;
  
  // Define active color (e.g., green for like, red for dislike)
  const likeActiveColor = 'var(--like-color, #10b981)'; // Example green color
  const dislikeActiveColor = 'var(--dislike-color, #ef4444)'; // Example red color

  // --- Regenerate Button (ONLY for bot messages) ---
  if (isBot) {
    const regenerateBtn = document.createElement('button');
    regenerateBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="icon"><path d="M3.502 16.6663V13.3333C3.502 12.9661 3.79977 12.6683 4.16704 12.6683H7.50004L7.63383 12.682C7.93691 12.7439 8.16508 13.0119 8.16508 13.3333C8.16508 13.6547 7.93691 13.9227 7.63383 13.9847L7.50004 13.9984H5.47465C6.58682 15.2249 8.21842 16.0013 10 16.0013C13.06 16.0012 15.5859 13.711 15.9551 10.7513L15.9854 10.6195C16.0845 10.3266 16.3785 10.1334 16.6973 10.1732C17.0617 10.2186 17.3198 10.551 17.2745 10.9154L17.2247 11.2523C16.6301 14.7051 13.6224 17.3313 10 17.3314C8.01103 17.3314 6.17188 16.5383 4.83208 15.2474V16.6663C4.83208 17.0335 4.53411 17.3311 4.16704 17.3314C3.79977 17.3314 3.502 17.0336 3.502 16.6663ZM4.04497 9.24935C3.99936 9.61353 3.66701 9.87178 3.30278 9.8265C2.93833 9.78105 2.67921 9.44876 2.72465 9.08431L4.04497 9.24935ZM10 2.66829C11.9939 2.66833 13.8372 3.46551 15.1778 4.76204V3.33333C15.1778 2.96616 15.4757 2.66844 15.8428 2.66829C16.2101 2.66829 16.5079 2.96606 16.5079 3.33333V6.66634C16.5079 7.03361 16.2101 7.33138 15.8428 7.33138H12.5098C12.1425 7.33138 11.8448 7.03361 11.8448 6.66634C11.8449 6.29922 12.1426 6.0013 12.5098 6.0013H14.5254C13.4133 4.77488 11.7816 3.99841 10 3.99837C6.93998 3.99837 4.41406 6.28947 4.04497 9.24935L3.38481 9.16634L2.72465 9.08431C3.17574 5.46702 6.26076 2.66829 10 2.66829Z"></path></svg>';
    regenerateBtn.style.cssText = buttonStyle;
    regenerateBtn.title = 'Regenerate response';
    regenerateBtn.setAttribute('aria-label', 'Regenerate AI response');
    regenerateBtn.onclick = () => regenerateAnswer(regenerateBtn);
    actionsContainer.appendChild(regenerateBtn);
  }

  // --- Copy Button ---
  const copyBtn = document.createElement('button');
  copyBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="icon"><path d="M12.668 10.667C12.668 9.95614 12.668 9.46258 12.6367 9.0791C12.6137 8.79732 12.5758 8.60761 12.5244 8.46387L12.4688 8.33399C12.3148 8.03193 12.0803 7.77885 11.793 7.60254L11.666 7.53125C11.508 7.45087 11.2963 7.39395 10.9209 7.36328C10.5374 7.33197 10.0439 7.33203 9.33301 7.33203H6.5C5.78896 7.33203 5.29563 7.33195 4.91211 7.36328C4.63016 7.38632 4.44065 7.42413 4.29688 7.47559L4.16699 7.53125C3.86488 7.68518 3.61186 7.9196 3.43555 8.20703L3.36524 8.33399C3.28478 8.49198 3.22795 8.70352 3.19727 9.0791C3.16595 9.46259 3.16504 9.95611 3.16504 10.667V13.5C3.16504 14.211 3.16593 14.7044 3.19727 15.0879C3.22797 15.4636 3.28473 15.675 3.36524 15.833L3.43555 15.959C3.61186 16.2466 3.86474 16.4807 4.16699 16.6348L4.29688 16.6914C4.44063 16.7428 4.63025 16.7797 4.91211 16.8027C5.29563 16.8341 5.78896 16.835 6.5 16.835H9.33301C10.0439 16.835 10.5374 16.8341 10.9209 16.8027C11.2965 16.772 11.508 16.7152 11.666 16.6348L11.793 16.5645C12.0804 16.3881 12.3148 16.1351 12.4688 15.833L12.5244 15.7031C12.5759 15.5594 12.6137 15.3698 12.6367 15.0879C12.6681 14.7044 12.668 14.211 12.668 13.5V10.667ZM13.998 12.665C14.4528 12.6634 14.8011 12.6602 15.0879 12.6367C15.4635 12.606 15.675 12.5492 15.833 12.4688L15.959 12.3975C16.2466 12.2211 16.4808 11.9682 16.6348 11.666L16.6914 11.5361C16.7428 11.3924 16.7797 11.2026 16.8027 10.9209C16.8341 10.5374 16.835 10.0439 16.835 9.33301V6.5C16.835 5.78896 16.8341 5.29563 16.8027 4.91211C16.7797 4.63025 16.7428 4.44063 16.6914 4.29688L16.6348 4.16699C16.4807 3.86474 16.2466 3.61186 15.959 3.43555L15.833 3.36524C15.675 3.28473 15.4636 3.22797 15.0879 3.19727C14.7044 3.16593 14.211 3.16504 13.5 3.16504H10.667C9.9561 3.16504 9.46259 3.16595 9.0791 3.19727C8.79739 3.22028 8.6076 3.2572 8.46387 3.30859L8.33399 3.36524C8.03176 3.51923 7.77886 3.75343 7.60254 4.04102L7.53125 4.16699C7.4508 4.32498 7.39397 4.53655 7.36328 4.91211C7.33985 5.19893 7.33562 5.54719 7.33399 6.00195H9.33301C10.022 6.00195 10.5791 6.00131 11.0293 6.03809C11.4873 6.07551 11.8937 6.15471 12.2705 6.34668L12.4883 6.46875C12.984 6.7728 13.3878 7.20854 13.6533 7.72949L13.7197 7.87207C13.8642 8.20859 13.9292 8.56974 13.9619 8.9707C13.9987 9.42092 13.998 9.97799 13.998 10.667V12.665ZM18.165 9.33301C18.165 10.022 18.1657 10.5791 18.1289 11.0293C18.0961 11.4302 18.0311 11.7914 17.8867 12.1279L17.8203 12.2705C17.5549 12.7914 17.1509 13.2272 16.6553 13.5313L16.4365 13.6533C16.0599 13.8452 15.6541 13.9245 15.1963 13.9619C14.8593 13.9895 14.4624 13.9935 13.9951 13.9951C13.9935 14.4624 13.9895 14.8593 13.9619 15.1963C13.9292 15.597 13.864 15.9576 13.7197 16.2939L13.6533 16.4365C13.3878 16.9576 12.9841 17.3941 12.4883 17.6982L12.2705 17.8203C11.8937 18.0123 11.4873 18.0915 11.0293 18.1289C10.5791 18.1657 10.022 18.165 9.33301 18.165H6.5C5.81091 18.165 5.25395 18.1657 4.80371 18.1289C4.40306 18.0962 4.04235 18.031 3.70606 17.8867L3.56348 17.8203C3.04244 17.5548 2.60585 17.151 2.30176 16.6553L2.17969 16.4365C1.98788 16.0599 1.90851 15.6541 1.87109 15.1963C1.83431 14.746 1.83496 14.1891 1.83496 13.5V10.667C1.83496 9.978 1.83432 9.42091 1.87109 8.9707C1.90851 8.5127 1.98772 8.10625 2.17969 7.72949L2.30176 7.51172C2.60586 7.0159 3.04236 6.6122 3.56348 6.34668L3.70606 6.28027C4.04237 6.136 4.40303 6.07083 4.80371 6.03809C5.14051 6.01057 5.53708 6.00551 6.00391 6.00391C6.00551 5.53708 6.01057 5.14051 6.03809 4.80371C6.0755 4.34588 6.15483 3.94012 6.34668 3.56348L6.46875 3.34473C6.77282 2.84912 7.20856 2.44514 7.72949 2.17969L7.87207 2.11328C8.20855 1.96886 8.56979 1.90385 8.9707 1.87109C9.42091 1.83432 9.978 1.83496 10.667 1.83496H13.5C14.1891 1.83496 14.746 1.83431 15.1963 1.87109C15.6541 1.90851 16.0599 1.98788 16.4365 2.17969L16.6553 2.30176C17.151 2.60585 17.5548 3.04244 17.8203 3.56351L17.8867 3.70608C18.031 4.04235 18.0962 4.40306 18.1289 4.80371C18.1657 5.25395 18.165 5.81091 18.165 6.5V9.33301Z"></path></svg>';
  copyBtn.style.cssText = buttonStyle;
  copyBtn.onclick = () => copyMessageContent(copyBtn);
  actionsContainer.appendChild(copyBtn);
  
  // --- Read Aloud Button (ONLY for bot messages, added after copy) ---


  // Like & Dislike buttons ONLY for bot messages
  if (isBot) {
    // --- Like Button ---
    const likeBtn = document.createElement('button');
    likeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="icon"><path d="M10.9153 1.83987L11.2942 1.88772L11.4749 1.91507C13.2633 2.24201 14.4107 4.01717 13.9749 5.78225L13.9261 5.95901L13.3987 7.6719C13.7708 7.67575 14.0961 7.68389 14.3792 7.70608C14.8737 7.74486 15.3109 7.82759 15.7015 8.03323L15.8528 8.11819C16.5966 8.56353 17.1278 9.29625 17.3167 10.1475L17.347 10.3096C17.403 10.69 17.3647 11.0832 17.2835 11.5098C17.2375 11.7517 17.1735 12.0212 17.096 12.3233L16.8255 13.3321L16.4456 14.7276C16.2076 15.6001 16.0438 16.2356 15.7366 16.7305L15.595 16.9346C15.2989 17.318 14.9197 17.628 14.4866 17.8408L14.2982 17.9258C13.6885 18.1774 12.9785 18.1651 11.9446 18.1651H7.33331C6.64422 18.1651 6.08726 18.1657 5.63702 18.1289C5.23638 18.0962 4.87565 18.031 4.53936 17.8867L4.39679 17.8203C3.87576 17.5549 3.43916 17.151 3.13507 16.6553L3.013 16.4366C2.82119 16.0599 2.74182 15.6541 2.7044 15.1963C2.66762 14.7461 2.66827 14.1891 2.66827 13.5V11.667C2.66827 10.9349 2.66214 10.4375 2.77569 10.0137L2.83722 9.81253C3.17599 8.81768 3.99001 8.05084 5.01397 7.77639L5.17706 7.73928C5.56592 7.66435 6.02595 7.66799 6.66632 7.66799C6.9429 7.66799 7.19894 7.52038 7.33624 7.2803L10.2562 2.16995L10.3118 2.08792C10.4544 1.90739 10.6824 1.81092 10.9153 1.83987ZM7.33136 14.167C7.33136 14.9841 7.33714 15.2627 7.39386 15.4746L7.42999 15.5918C7.62644 16.1686 8.09802 16.6134 8.69171 16.7725L8.87042 16.8067C9.07652 16.8323 9.38687 16.835 10.0003 16.835H11.9446C13.099 16.835 13.4838 16.8228 13.7903 16.6963L13.8997 16.6465C14.1508 16.5231 14.3716 16.3444 14.5433 16.1221L14.6155 16.0166C14.7769 15.7552 14.8968 15.3517 15.1624 14.378L15.5433 12.9824L15.8079 11.9922C15.8804 11.7102 15.9368 11.4711 15.9769 11.2608C16.0364 10.948 16.0517 10.7375 16.0394 10.5791L16.0179 10.4356C15.9156 9.97497 15.641 9.57381 15.2542 9.31253L15.0814 9.20999C14.9253 9.12785 14.6982 9.06544 14.2747 9.03225C13.8477 8.99881 13.2923 8.99807 12.5003 8.99807C12.2893 8.99807 12.0905 8.89822 11.9651 8.72854C11.8398 8.55879 11.8025 8.33942 11.8646 8.13772L12.6556 5.56741L12.7054 5.36331C12.8941 4.35953 12.216 3.37956 11.1878 3.2178L8.49054 7.93948C8.23033 8.39484 7.81431 8.72848 7.33136 8.88967V14.167ZM3.99835 13.5C3.99835 14.2111 3.99924 14.7044 4.03058 15.0879C4.06128 15.4636 4.11804 15.675 4.19854 15.833L4.26886 15.959C4.44517 16.2466 4.69805 16.4808 5.0003 16.6348L5.13019 16.6905C5.27397 16.7419 5.46337 16.7797 5.74542 16.8028C5.97772 16.8217 6.25037 16.828 6.58722 16.8311C6.41249 16.585 6.27075 16.3136 6.1712 16.0215L6.10968 15.8194C5.99614 15.3956 6.00128 14.899 6.00128 14.167V9.00296C5.79386 9.0067 5.65011 9.01339 5.53741 9.02737L5.3587 9.06057C4.76502 9.21965 4.29247 9.66448 4.09601 10.2412L4.06085 10.3584C4.00404 10.5705 3.99835 10.8493 3.99835 11.667V13.5Z"></path></svg>';
    likeBtn.style.cssText = buttonStyle;

    // --- Dislike Button ---
    const dislikeBtn = document.createElement('button');
    dislikeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="icon"><path d="M12.6687 5.83304C12.6687 5.22006 12.6649 4.91019 12.6394 4.70413L12.6062 4.52542C12.4471 3.93179 12.0022 3.45922 11.4255 3.26272L11.3083 3.22757C11.0963 3.17075 10.8175 3.16507 9.99974 3.16507H8.0554C7.04558 3.16507 6.62456 3.17475 6.32982 3.26175L6.2097 3.30374C5.95005 3.41089 5.71908 3.57635 5.53392 3.78616L5.45677 3.87796C5.30475 4.0748 5.20336 4.33135 5.03392 4.91702L4.83763 5.6221L4.45677 7.01761C4.24829 7.78204 4.10326 8.31846 4.02318 8.73929C3.94374 9.15672 3.94298 9.39229 3.98119 9.56448L4.03587 9.75784C4.18618 10.1996 4.50043 10.5702 4.91771 10.7901L5.05052 10.8477C5.20009 10.9014 5.40751 10.9429 5.72533 10.9678C6.15231 11.0012 6.70771 11.002 7.49974 11.002C7.71076 11.002 7.90952 11.1018 8.0349 11.2715C8.14465 11.4201 8.18683 11.6067 8.15404 11.7862L8.13548 11.8623L7.34447 14.4326C7.01523 15.5033 7.71404 16.6081 8.81126 16.7813L11.5095 12.0606L11.5827 11.9405C11.8445 11.5461 12.2289 11.2561 12.6687 11.1094V5.83304ZM17.3318 8.33304C17.3318 8.97366 17.3364 9.43432 17.2615 9.82327L17.2234 9.98538C16.949 11.0094 16.1821 11.8233 15.1872 12.1621L14.9861 12.2237C14.5624 12.3372 14.0656 12.3321 13.3337 12.3321C13.0915 12.3321 12.8651 12.4453 12.7204 12.6348L12.6638 12.7198L9.74388 17.8301C9.61066 18.0631 9.35005 18.1935 9.08372 18.1602L8.70579 18.1123C6.75379 17.8682 5.49542 15.9213 6.07396 14.041L6.60033 12.3272C6.22861 12.3233 5.90377 12.3161 5.62083 12.294C5.18804 12.26 4.79914 12.1931 4.44701 12.0391L4.29857 11.9668C3.52688 11.5605 2.95919 10.8555 2.72533 10.0205L2.68333 9.85257C2.58769 9.42154 2.62379 8.97768 2.71654 8.49026C2.80865 8.00634 2.97082 7.41139 3.17357 6.668L3.55443 5.27249L3.74583 4.58011C3.9286 3.94171 4.10186 3.45682 4.40404 3.06546L4.53685 2.9053C4.85609 2.54372 5.25433 2.25896 5.70189 2.07425L5.93626 1.99222C6.49455 1.82612 7.15095 1.83499 8.0554 1.83499H12.6667C13.3558 1.83499 13.9128 1.83434 14.363 1.87112C14.8208 1.90854 15.2266 1.98789 15.6033 2.17972L15.821 2.30179C16.317 2.6059 16.7215 3.04226 16.987 3.56351L17.0535 3.70608C17.1977 4.04236 17.2629 4.40311 17.2956 4.80374C17.3324 5.25398 17.3318 5.81094 17.3318 6.50003V8.33304ZM13.9978 10.9961C14.3321 10.9901 14.5013 10.977 14.6413 10.9395L14.7585 10.9033C15.3353 10.7069 15.7801 10.2353 15.9392 9.64163L15.9724 9.46292C15.998 9.25682 16.0017 8.94657 16.0017 8.33304V6.50003C16.0017 5.78899 16.0008 5.29566 15.9695 4.91214C15.9464 4.6301 15.9086 4.44069 15.8572 4.2969L15.8015 4.16702C15.6475 3.86478 15.4133 3.6119 15.1257 3.43558L14.9997 3.36526C14.8418 3.28477 14.6302 3.228 14.2546 3.19729C14.0221 3.1783 13.7491 3.17109 13.4118 3.168C13.6267 3.47028 13.7914 3.81126 13.8904 4.18069L13.9275 4.34378C13.981 4.62163 13.9947 4.93582 13.9978 5.3262V10.9961Z"></path></svg>';
    dislikeBtn.style.cssText = buttonStyle;

    // --- Helper to get the path element inside the SVG ---
    const getPath = (btn) => btn.querySelector('svg path');

    // --- Toggle Logic Implementation ---
    likeBtn.onclick = () => {
      const path = getPath(likeBtn);
      const isCurrentlyActive = likeBtn.classList.contains('active');
      const inactiveColor = 'var(--text-color, #aaa)';

      if (isCurrentlyActive) {
        // Toggle off (remove like, show dislike)
        likeBtn.classList.remove('active');
        path.style.fill = inactiveColor;
        dislikeBtn.style.display = 'block';
      } else {
        // Toggle on (add like, fill icon, hide dislike)
        likeBtn.classList.add('active');
        path.style.fill = likeActiveColor; // Set to active color
        dislikeBtn.style.display = 'none';
        
        // Ensure dislike is inactive/hidden/unfilled
        dislikeBtn.classList.remove('active');
        getPath(dislikeBtn).style.fill = inactiveColor;
      }
    };

    dislikeBtn.onclick = () => {
      const path = getPath(dislikeBtn);
      const isCurrentlyActive = dislikeBtn.classList.contains('active');
      const inactiveColor = 'var(--text-color-inactive, #aaa)';

      if (isCurrentlyActive) {
        // Toggle off (remove dislike, show like)
        dislikeBtn.classList.remove('active');
        path.style.fill = inactiveColor;
        likeBtn.style.display = 'block';
      } else {
        // Toggle on (add dislike, fill icon, hide like)
        dislikeBtn.classList.add('active');
        path.style.fill = dislikeActiveColor; // Set to active color
        likeBtn.style.display = 'none';
        
        // Ensure like is inactive/hidden/unfilled
        likeBtn.classList.remove('active');
        getPath(likeBtn).style.fill = inactiveColor;
      }
    };

    actionsContainer.appendChild(likeBtn);
    actionsContainer.appendChild(dislikeBtn);
  }
    if (isBot) {
    const readAloudBtn = document.createElement('button');
    // Initial state setup using the reset helper
    resetReadAloudButton(readAloudBtn); 
    readAloudBtn.style.cssText = buttonStyle;
    readAloudBtn.onclick = () => readMessageAloud(readAloudBtn);
    actionsContainer.appendChild(readAloudBtn);
  }

  // --- Edit Button ---
  if (isUser) {
    const editBtn = document.createElement('button');
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9.94073 1.34948C10.7047 0.902375 11.6503 0.90248 12.4143 1.34948C12.706 1.52022 12.9687 1.79124 13.3104 2.1329C13.652 2.47454 13.9231 2.73727 14.0938 3.029C14.5408 3.79301 14.5409 4.73862 14.0938 5.50257C13.9231 5.79422 13.652 6.0571 13.3104 6.39867L6.65929 13.0498C6.28065 13.4284 6.00692 13.7108 5.6654 13.9097C5.32388 14.1085 4.94312 14.2074 4.42702 14.3498L3.24391 14.6762C2.77524 14.8054 2.34535 14.9263 2.00128 14.9685C1.65193 15.0112 1.17961 15.0014 0.810733 14.6326C0.44189 14.2637 0.432076 13.7914 0.474829 13.442C0.517004 13.098 0.63787 12.668 0.767151 12.1994L1.09349 11.0163C1.23585 10.5002 1.33478 10.1194 1.53356 9.77791C1.73246 9.43639 2.01487 9.16266 2.39352 8.78402L9.04463 2.1329C9.38622 1.79132 9.64908 1.52023 9.94073 1.34948ZM15.5427 14.8399H7.5522L8.96704 13.425H15.5427V14.8399ZM3.39379 9.78429C2.96497 10.2131 2.84241 10.3437 2.75706 10.4901C2.6718 10.6366 2.61858 10.8079 2.4573 11.3926L2.13096 12.5757C2.0018 13.0439 1.92191 13.3419 1.8886 13.5536C2.10038 13.5204 2.39869 13.4417 2.86761 13.3123L4.05072 12.986C4.63541 12.8247 4.80666 12.7715 4.9532 12.6862C5.09965 12.6009 5.23019 12.4783 5.65902 12.0495L10.721 6.9865L8.45574 4.72128L3.39379 9.78429ZM11.7 2.57085C11.3774 2.38205 10.9777 2.38205 10.6551 2.57085C10.5602 2.62653 10.4487 2.72937 10.0449 3.13317L9.45601 3.72101L11.7212 5.98623L12.3101 5.3984C12.7139 4.99464 12.8168 4.88314 12.8725 4.78825C13.0612 4.46567 13.0612 4.06592 12.8725 3.74333C12.8168 3.64834 12.7145 3.53758 12.3101 3.13317C11.9057 2.72869 11.795 2.62647 11.7 2.57085Z"></path></svg>';
    editBtn.style.cssText = buttonStyle;
    editBtn.onclick = () => editUserMessage(editBtn);
    actionsContainer.appendChild(editBtn);
  }

  const messageContent = messageElement.querySelector('.message-content');
  if (messageContent) {
    messageContent.parentNode.insertBefore(actionsContainer, messageContent.nextSibling); 
  } else {
    messageElement.appendChild(actionsContainer);
  }
}

// Observer to add buttons to new messages
const chatbox = document.getElementById('chatbox');
if (chatbox) {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList.contains('chat-message')) {
          requestAnimationFrame(() => addMessageActions(node));
        }
      });
    });
  });

  observer.observe(chatbox, { childList: true });

  window.addEventListener('load', () => {
    const existingMessages = chatbox.querySelectorAll('.chat-message');
    existingMessages.forEach(msg => addMessageActions(msg));
  });
}


// ==========================================================
// END: Code for Copy, Edit, Regenerate, and Read Aloud Functionality
// ==========================================================
