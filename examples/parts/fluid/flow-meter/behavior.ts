definePart({
  params: {
    flowTag: {
      type: 'tag',
      dir: 'out',
      stType: 'REAL',
      default: '',
      label: 'Flow rate tag (GPM)',
    },
  },
  step(ctx) {
    if (ctx.params.flowTag) {
      ctx.writeNumber(ctx.params.flowTag, ctx.fluid().flow)
    }
  },
})
