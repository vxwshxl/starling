// Ask for the microphone from a real tab.
//
// Why this page exists at all: a side panel frequently cannot surface the
// getUserMedia prompt. Chrome shows permission prompts anchored to a tab's
// address bar, and the panel is not a tab -- so the call is rejected
// immediately with NotAllowedError and no prompt is ever displayed. From the
// user's side it looks like the extension asked and was refused, when nothing
// asked at all.
//
// Granting it here fixes it for the panel too: the permission is stored
// against the extension's ORIGIN, not against whichever of its pages happened
// to request it. So this runs once, in a tab, and the panel's microphone
// works from then on.

const button = document.getElementById("grant");
const state = document.getElementById("state");
const manual = document.getElementById("manual");
document.getElementById("origin").textContent = location.origin;

function say(text, kind) {
  state.textContent = text;
  state.className = `state ${kind || ""}`;
}

async function grant() {
  button.disabled = true;
  say("Waiting for you to choose…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Release the device straight away. Holding it would leave the recording
    // indicator lit in the tab strip for as long as this page stayed open,
    // which reads as the extension listening when it is not.
    stream.getTracks().forEach((track) => track.stop());
    say("Microphone allowed. You can close this tab and use the panel.", "ok");
    button.hidden = true;
  } catch (err) {
    button.disabled = false;
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      say("No microphone found on this machine.", "bad");
      return;
    }
    say("Chrome did not allow it.", "bad");
    // A dismissed prompt can be retried; a hard block cannot, and the only
    // way out of that is the settings page.
    manual.hidden = false;
  }
}

button.addEventListener("click", grant);

// Report where things already stand, so somebody who has already granted it
// is not left pressing a button that appears to do nothing.
navigator.permissions
  ?.query({ name: "microphone" })
  .then((status) => {
    if (status.state === "granted") {
      say("The microphone is already allowed. The panel can use it.", "ok");
      button.hidden = true;
    } else if (status.state === "denied") {
      say("The microphone is blocked for this extension.", "bad");
      manual.hidden = false;
    }
  })
  .catch(() => {
    /* Permissions.query is not available for every name in every build. */
  });
