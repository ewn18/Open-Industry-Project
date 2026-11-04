definePart({
  params: {
    levelTag: {
      type: 'tag',
      dir: 'out',
      stType: 'REAL',
      default: '',
      label: 'Level tag (m)',
    },
  },
  step(ctx) {
    if (ctx.params.levelTag) {
      ctx.writeNumber(ctx.params.levelTag, ctx.fluid().level ?? 0)
    }
  },
})
