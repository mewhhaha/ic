export type Format<self> = {
  fmt: (value: self) => string;
};

export type Emit<from, to> = {
  emit: (value: from) => to;
};
