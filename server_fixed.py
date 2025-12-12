import fastapi
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import threading
from pyngrok import ngrok
import os
import time
import socket
import gc
import logging

# Suppress pyngrok warnings to keep stderr clean
logging.getLogger("pyngrok").setLevel(logging.ERROR)

# Initialize global variables if they don't exist in the kernel state
if 'active_server' not in globals():
    active_server = None
if 'server_thread' not in globals():
    server_thread = None

# Define a simple FastAPI app
app = fastapi.FastAPI()

# --- FIX: Add CORS Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allow all methods
    allow_headers=["*"],  # Allow all headers
)
# --------------------------------

@app.get("/")
def read_root():
    return {"message": "Server is running in background with CORS enabled!"}

# Add a dummy chat completions endpoint to satisfy the client's check if needed, 
# or ensure your actual logic (not shown in your snippet) is attached.
# Assuming the user might attach other routes later or this is just the skeleton.
@app.post("/v1/chat/completions")
async def chat_completions(request: fastapi.Request):
    try:
        from google.colab import ai
    except ImportError:
        return {"error": "google.colab.ai not found. This server must be run in Google Colab."}

    try:
        body = await request.json()
        print(f"Received request: {body}")
        
        # Extract the last user message
        messages = body.get("messages", [])
        if not messages:
            return {"error": "No messages provided"}
            
        last_message = messages[-1]
        prompt = last_message.get("content", "")
        
        requested_model = body.get("model", "gemini-2.0-flash")
        
        # Map client model names to Colab model names
        # Dynamic lookup: Find the best matching model from available Colab models
        try:
            available_models = list(ai.list_models())
            print(f"Available Colab Models: {available_models}")
        except Exception as e:
            print(f"Could not list models: {e}")
            available_models = []

        colab_model = None
        
        # 1. Direct Model Map (Overrides)
        model_map = {
            "gemini-2.5-pro": "google/gemini-2.0-pro-exp-02-05",
            "gemini-2.5-flash": "google/gemini-2.0-flash-001",
        }
        
        if requested_model in model_map:
            colab_model = model_map[requested_model]
        
        # 2. Fuzzy Search if not mapped
        if not colab_model:
            # Normalize request (e.g., "gemini-3.0-pro" -> "gemini-3.0-pro")
            search_term = requested_model.lower().replace("preview", "").replace("exp", "")
            
            # Simple heuristic: look for the most specific match
            for m in available_models:
                m_name = m.name if hasattr(m, 'name') else str(m)
                if search_term in m_name.lower():
                    colab_model = m_name
                    break
            
            # Special case for "Gemini 3" if user just asks for it generically
            if not colab_model and "gemini-3" in requested_model:
                 for m in available_models:
                    m_name = m.name if hasattr(m, 'name') else str(m)
                    if "gemini-3" in m_name.lower(): # Match any Gemini 3
                        colab_model = m_name
                        break

        # 3. Fallback
        if not colab_model:
             colab_model = "google/gemini-2.0-flash-001" 
             print("Model not found in map or list. Using fallback.")

        print(f"Mapping {requested_model} -> {colab_model}")

        # Generate text
        try:
            generated_text = ai.generate_text(prompt, model_name=colab_model)
        except Exception as gen_error:
            print(f"Generation error with {colab_model}: {gen_error}")
            # Fallback
            fallback_model = "google/gemini-2.0-flash-lite-preview-02-05"
            print(f"Retrying with fallback: {fallback_model}")
            generated_text = ai.generate_text(prompt, model_name=fallback_model)

        print(f"Generated text length: {len(generated_text)}")

        # Return in OpenAI-compatible format
        return {
            "choices": [
                {
                    "message": {
                        "content": generated_text
                    }
                }
            ]
        }
    except Exception as e:
        print(f"Error handling request: {e}")
        # Return a 500 error so the client's !response.ok block catches it and prints the error body
        return fastapi.Response(content=str(e), status_code=500)

def cleanup():
    global active_server, server_thread
    # Stop the active server if it exists
    if active_server:
        print("Stopping existing server...")
        active_server.should_exit = True
        # Wait for the server to shut down
        if server_thread and server_thread.is_alive():
            server_thread.join(timeout=5)
            if server_thread.is_alive():
                print("Warning: Server thread did not exit within timeout.")
            else:
                print("Existing server stopped.")
        active_server = None
        server_thread = None
    
    # Run garbage collection
    gc.collect()

def run_server(port):
    global active_server
    try:
        # Initialize uvicorn config with reduced logging
        config = uvicorn.Config(app, host='127.0.0.1', port=port, log_level="warning")
        server = uvicorn.Server(config)
        
        # Monkey-patch to prevent signal handler errors in Colab
        server.install_signal_handlers = lambda: None
        
        # Store the server instance
        active_server = server
        
        # Run the server
        server.run()
    except SystemExit:
        print(f"Server thread on port {port} stopped.")
    except Exception as e:
        print(f"Error in server thread: {e}")

def start_server_startup():
    global server_thread
    cleanup()
    
    # Configure pyngrok
    if 'ngrok_auth_token' in globals():
        ngrok.set_auth_token(ngrok_auth_token)
    else:
        print("Warning: ngrok_auth_token not found.")

    # Find an available port
    port = None
    for p in range(50000, 50005):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = s.connect_ex(('127.0.0.1', p))
        s.close()
        if result != 0:
            port = p
            break
    
    if port is None:
        print("No available ports found between 50000 and 50004.")
        return

    print(f"Selected port: {port}")

    # Start server in a new daemon thread
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()
    
    # Wait for initialization
    time.sleep(3)
    
    if not server_thread.is_alive():
        print("Server thread failed to start.")
        return

    # Open ngrok tunnel
    try:
        tunnels = ngrok.get_tunnels()
        for t in tunnels:
            ngrok.disconnect(t.public_url)
        
        public_url = ngrok.connect(port).public_url
        print(f"Server started! Public URL: {public_url}")
    except Exception as e:
        print(f"Failed to start ngrok tunnel: {e}")

# Execute startup
start_server_startup()
