import requests
import os
from dotenv import load_dotenv

# Load your .env file
load_dotenv()

ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID")
AUTH_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN")

def test_cloudflare_ai():
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell"
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    
    payload = {
        "prompt": "A simple metallic gear on a white background, professional photography",
        "steps": 4, # Fast generation for testing
        "width": 256,
        "height": 256
    }

    print(f"--- Testing Connection for Account: {ACCOUNT_ID[:6]}... ---")
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        
        if response.status_code == 200:
            print("✅ SUCCESS! Authentication valid.")
            with open("test_image.png", "wb") as f:
                f.write(response.content)
            print("Saved test result to 'test_image.png'")
        else:
            print(f"❌ FAILED: {response.status_code}")
            print(f"Response: {response.text}")
            
    except Exception as e:
        print(f"❗ Error: {str(e)}")

if __name__ == "__main__":
    test_cloudflare_ai()