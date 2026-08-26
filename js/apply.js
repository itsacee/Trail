const form = document.getElementById("applyForm");
if (form) {
  const statusEl = document.getElementById("applyStatus");
  const submitBtn = document.getElementById("applySubmit");
  const done = document.getElementById("applyDone");
  const dayBoxes = [...form.querySelectorAll('input[name="days"]')];

  dayBoxes.forEach((box) => {
    box.addEventListener("change", () => {
      const on = dayBoxes.filter((b) => b.checked);
      if (on.length > 3) {
        box.checked = false;
        if (statusEl) statusEl.textContent = "Pick exactly 3 days — that's the whole block.";
      } else if (statusEl && statusEl.textContent.startsWith("Pick exactly 3")) {
        statusEl.textContent = "";
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.classList.remove("booking__status--ok");

    const days = dayBoxes.filter((b) => b.checked).map((b) => b.value);
    if (days.length !== 3) {
      statusEl.textContent = "Pick exactly 3 days — same days every week.";
      return;
    }
    if (!form.elements.player.value.trim() || !form.elements.age.value.trim()) {
      statusEl.textContent = "Please enter the player's name and age / grade.";
      return;
    }
    if (!form.elements.phone.value.trim()) {
      statusEl.textContent = "I need a phone number so I can reach you.";
      form.elements.phone.focus();
      return;
    }
    if (!form.elements.email.checkValidity()) {
      statusEl.textContent = "Please enter a valid email.";
      form.elements.email.focus();
      return;
    }
    if (!form.elements.time.value) {
      statusEl.textContent = "Pick the time you'd want every week.";
      return;
    }
    if (!form.elements.why.value.trim()) {
      statusEl.textContent = "Tell me what they're working toward this month.";
      form.elements.why.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player: form.elements.player.value.trim(),
          age: form.elements.age.value.trim(),
          parent: form.elements.parent.value.trim(),
          phone: form.elements.phone.value.trim(),
          email: form.elements.email.value.trim(),
          team: form.elements.team.value.trim(),
          focus: form.elements.focus.value,
          why: form.elements.why.value.trim(),
          days,
          time: form.elements.time.value,
          notes: form.elements.notes.value.trim(),
          company: form.elements.company.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.sent) {
        form.hidden = true;
        if (done) done.hidden = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      statusEl.textContent = data.error || "Couldn't send it. Text (405) 819-4401 and I'll take it from there.";
    } catch {
      statusEl.textContent = "Couldn't send it. Text (405) 819-4401 and I'll take it from there.";
    }
    submitBtn.disabled = false;
    submitBtn.textContent = "Send application";
  });
}
