const button = document.querySelector("#test-button");
const result = document.querySelector("#result");

button.addEventListener("click", () => {
  result.textContent = "Interaction passed";
});