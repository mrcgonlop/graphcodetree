; capture name conventions drive the classifier
(function_item name: (identifier) @name) @definition.function
(struct_item   name: (type_identifier) @name) @definition.type
(call_expression function: (identifier) @name) @reference.call
(use_declaration) @import