// Copy buttons on the viewer page.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const input = document.getElementById(button.dataset.copy);
  if (!input) return;
  input.select();
  const done = () => {
    button.textContent = 'কপি হয়েছে';
    setTimeout(() => { button.textContent = 'কপি'; }, 1500);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, () => {});
  else if (document.execCommand('copy')) done();
});
