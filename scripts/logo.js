const sharp = require('sharp');
(async () => {
  await sharp('assets/logo.svg').png({ palette: true, colors: 32 }).toFile('assets/logo-900.png');
  await sharp('assets/logo.svg').resize(256, 256).png({ palette: true, colors: 32 }).toFile('assets/logo-256.png');
  await sharp('assets/logo.svg').resize(64, 64).png().toFile('public/favicon.png');
  console.log('logos written');
})();
