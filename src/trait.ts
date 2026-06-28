export type Format<self> = {
  fmt: (this: self) => string;
};

export type Emit<from, to> = {
  emit: (this: from) => to;
};

export type Reduce<self> = {
  reduce: (this: self) => self;
};

export type Fn<self> = {
  arity: (this: self) => number;
};
