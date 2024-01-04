particlesJS.load("particles-js", "/assets/particles.json", function () {
  console.log("callback - particles.js config loaded");
});

window.onload = function () {
  document.getElementById("content").classList.remove("fadeout");
};

window.onbeforeunload = function (e) {
  document.getElementById("content").classList.add("fadeout");
};

window.onpageshow = function () {
  document.getElementById("content").classList.remove("fadeout");
};

function copyMarkdown(role) {
  var link = `https://badges.pangora.social/api/v1/recap/2023/${role}`;
  var markdown = `![${role}](${link})`;
  navigator.clipboard.writeText(markdown);

  Toastify({
    text: `Markdown copied to clipboard!`,
    duration: 3000,
    gravity: "bottom",
    position: "left",
    stopOnFocus: true,
    style: {
      background: "linear-gradient(to right, #0061b0, #00b0ad)",
    },
    close: true,
  }).showToast();
}
