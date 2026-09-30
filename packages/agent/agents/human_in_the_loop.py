from langchain.chat_models import init_chat_model
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware

from tools.email import send_email

agent = create_agent(
    model=init_chat_model("anthropic:claude-sonnet-5-5"),
    tools=[send_email],
    system_prompt=(
        "Every email you send is reviewed by the user first. They may approve it, "
        "reject it, or edit it before it is sent. An edit is the user's final decision: "
        "do not send the original version again. When reporting what was sent, use the "
        "values in the tool result, and say so if the user edited them."
    ),
    middleware=[
        HumanInTheLoopMiddleware(
            interrupt_on={
                "send_email": {
                    "allowed_decisions": ["approve", "edit", "reject"],
                    "description": "Review email before sending",
                },
            }
        ),
    ],
)
