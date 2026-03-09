const SIZE = 96

function makeEmojiIcon(emoji, { rotate = 0, fontSize = 0.5 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  ctx.translate(SIZE / 2, SIZE / 2)
  if (rotate) ctx.rotate(rotate * Math.PI / 180)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${SIZE * fontSize}px serif`
  ctx.fillText(emoji, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const imageData = ctx.getImageData(0, 0, SIZE, SIZE)
  return { width: SIZE, height: SIZE, data: new Uint8Array(imageData.data.buffer) }
}

// Original SVG icons for distant zoom
export function makeCivilianSVG(color) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <ellipse cx="16" cy="15" rx="2.5" ry="13" fill="${color}"/>
      <polygon points="16,13 1,22 13.5,20" fill="${color}" opacity="0.88"/>
      <polygon points="16,13 31,22 18.5,20" fill="${color}" opacity="0.88"/>
      <polygon points="16,27 8,31 14.5,29" fill="${color}" opacity="0.72"/>
      <polygon points="16,27 24,31 17.5,29" fill="${color}" opacity="0.72"/>
    </svg>`,
  )}`
}

export function makeMilitarySVG(color) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <polygon points="16,1 18,30 16,26 14,30" fill="${color}"/>
      <polygon points="16,9 30,28 16,22 2,28" fill="${color}" opacity="0.88"/>
      <polygon points="16,10 23,16 16,13 9,16" fill="${color}" opacity="0.65"/>
    </svg>`,
  )}`
}

export function makeUnknownSVG(color) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <polygon points="16,1 18,30 16,26 14,30" fill="${color}"/>
      <polygon points="16,9 30,28 16,22 2,28" fill="${color}" opacity="0.88"/>
      <polygon points="16,10 23,16 16,13 9,16" fill="${color}" opacity="0.65"/>
      <circle cx="16" cy="6" r="3" fill="${color}" opacity="0.6"/>
    </svg>`,
  )}`
}

export function loadMapIcons(map) {
  // SVG icons for distant zoom
  const loadSvg = (name, svgFn, color) => {
    const img = new Image()
    img.onload = () => { if (!map.hasImage(name)) map.addImage(name, img) }
    img.src = svgFn(color)
  }
  loadSvg('aircraft-civilian', makeCivilianSVG, '#4ade80')
  loadSvg('aircraft-military', makeMilitarySVG, '#ef4444')
  loadSvg('aircraft-unknown', makeUnknownSVG, '#f59e0b')

  // Emoji icons for close zoom
  if (!map.hasImage('aircraft-emoji')) {
    map.addImage('aircraft-emoji', makeEmojiIcon('✈️️', { rotate: -45 }), { pixelRatio: 2 })
  }
  if (!map.hasImage('fire-emoji')) {
    map.addImage('fire-emoji', makeEmojiIcon('🔥', { fontSize: 0.6 }), { pixelRatio: 2 })
  }
}
