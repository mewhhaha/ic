(arrow_function body: (_) @function.inside) @function.around
(recursive_function body: (_) @function.inside) @function.around

(parameter) @parameter.inside
(parameter_list (parameter) @parameter.around)

(comment) @comment.inside
(comment)+ @comment.around

(block (_) @class.inside) @class.around
