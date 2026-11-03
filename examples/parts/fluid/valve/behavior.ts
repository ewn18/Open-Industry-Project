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
  },
  step(ctx) {
    ctx.setFluid({ open: ctx.params.opening })
  },
})
