const filesInput = document.getElementById('files');
const tracks = document.getElementById('tracks');
const player = document.getElementById('player');
const urls = [];

filesInput.onchange = () => {
  tracks.innerHTML = '';
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.length = 0;
  [...filesInput.files].forEach((file) => {
    const url = URL.createObjectURL(file);
    urls.push(url);
    const li = document.createElement('li');
    li.textContent = file.name;
    li.onclick = () => {
      player.src = url;
      player.play();
    };
    tracks.appendChild(li);
  });
};
