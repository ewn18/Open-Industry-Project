definePart({
  params: {
    pressureTag: {
      type: 'tag',
      dir: 'out',
      stType: 'REAL',
      default: '',
      label: 'Pressure tag (PSI)',
    },
  },
  step(ctx) {
    if (ctx.params.pressureTag) {
      ctx.writeNumber(ctx.params.pressureTag, ctx.fluid().pressure)
    }
  },
})
