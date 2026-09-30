import json
import time

from langchain_core.tools import tool


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a recipient with a subject and body."""
    msg_id = f"msg_{int(time.time()):x}"
    return json.dumps({
        "status": "sent",
        "messageId": msg_id,
        "to": to,
        "subject": subject,
        "body": body,
        "summary": f'Email "{subject}" sent to {to} with body: "{body}"',
    })
