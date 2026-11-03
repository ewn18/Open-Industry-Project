definePart({
  params: {
    speed: {
      type: 'number',
      default: 0.65,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Pump speed',
    },
  },
  step(ctx) {
    ctx.setFluid({ speed: ctx.params.speed })
  },
})
