
import fs from 'fs'
import path from 'path'

const files = [
  'src/features/wms/WmsPage.tsx',
  'src/features/treasury/TesourariaPage.tsx',
  'src/features/projects/ProjetosPage.tsx',
  'src/features/mrp/ProducaoPage.tsx',
  'src/features/fleet/FrotaPage.tsx',
  'src/features/comex/ComexPage.tsx',
  'src/features/franchise/FranquiasPage.tsx',
  'src/features/assets/PatrimonioPage.tsx'
];

for (const filepath of files) {
  if (!fs.existsSync(filepath)) continue;
  let content = fs.readFileSync(filepath, 'utf8');
  let original = content;
  
  if (content.includes('{dash && (')) {
    content = content.replace('{dash && (', '');
    content = content.replace(/<\/KpiRow>\s*\)\}/, '</KpiRow>');
  }
  
  if (content !== original) {
    fs.writeFileSync(filepath, content);
    console.log('Fixed', filepath);
  }
}

