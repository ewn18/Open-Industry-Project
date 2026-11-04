definePart({
  params: {
    opening: {
      type: 'number',
      default: 0.75,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Valve opening',
    },
    openTag: {
      type: 'tag',
      dir: 'in',
      stType: 'REAL',
      default: '',
      label: 'Opening tag (0-1)',
    },
  },
  step(ctx) {
    const open = ctx.params.openTag && ctx.tagDriven(ctx.params.openTag)
      ? ctx.readNumber(ctx.params.openTag)
      : ctx.params.opening
    ctx.setFluid({ open })
  },
})
