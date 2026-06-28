export type Format<self> = {
  fmt: (value: self) => string;
};

export type Emit<from, to> = {
  emit: (value: from) => to;
};

export type CallableType<type> = {
  args: type[];
  result: type;
};

export type Callable<self, type> = {
  arity: (value: self) => number;
  type: (value: self) => CallableType<type>;
};

export type Reduce<self> = {
  reduce: (value: self) => self;
};
