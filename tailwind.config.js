/** Tailwind config — used only by scripts/build-css.sh to produce assets/app.css */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  theme: { extend: { minHeight: { 16: '4rem' } } },
  plugins: [],
};
