import requests
import json
import os

GATEWAY_URL = "http://localhost:8000/v1/solve"
INSTANCE_FILE = "examples/many_obj_valid_instance.json"

def test_many_obj():
    if not os.path.exists(INSTANCE_FILE):
        print(f"File {INSTANCE_FILE} not found.")
        return

    with open(INSTANCE_FILE, 'r') as f:
        instance = json.load(f)

    payload = {
        "engine_id": "many-obj",
        "instance": instance
    }

    print(f"Sending request to {GATEWAY_URL}...")
    try:
        resp = requests.post(GATEWAY_URL, json=payload)
        print(f"Status Code: {resp.status_code}")
        print("Response Body:")
        print(json.dumps(resp.json(), indent=2))
        
        if resp.status_code in (200, 202) and "result" in resp.json():
            print("SUCCESS: Valid solution received.")
        else:
            print("FAILURE: Unexpected response.")
            
    except Exception as e:
        print(f"Error sending request: {e}")

if __name__ == "__main__":
    test_many_obj()
