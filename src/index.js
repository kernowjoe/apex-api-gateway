#!/usr/bin/env node

const fs           = require('fs');
const path         = require('path');
const defaultsDeep = require('lodash.defaultsdeep');
const entries      = require('lodash.topairs');
const yargs        = require('yargs');
const AWS          = require('aws-sdk');

AWS.config.update({region: 'eu-west-2'});

const apigateway = new AWS.APIGateway();
const lambda     = new AWS.Lambda();

const args = yargs
	.usage('Usage: $0 <command> [options]')
	.alias('c', 'config')
	.nargs('c', 1)
	.describe('c', 'Apex project JSON file location')
	.command(
		'create <name> [description] [cloneFrom]', 'Create a new REST API on AWS API Gateway', {
			force: {alias: 'f', describe: 'Force creating REST API overriding existing configuration'}
		}, create
	)
	.command(
		'update', 'Update the REST API with the new Swagger definitions', {
			stdout: {describe: 'Output swagger to console without deploying'},
		}, update
	)
	.help()
	.argv;

function create({name, description = null, cloneFrom = '', config = './project.json', force}) {
	const projectConfig = loadConfig(config);

	!!projectConfig.region && AWS.config.update({region: projectConfig.region});

	if (!force && projectConfig && projectConfig['x-api-gateway'] && projectConfig['x-api-gateway']['rest-api-id']) {
		console.error(
			'A REST API id is already defined the project.json, if you really want to override this use -f parameter'
		);
		return;
	}

	var params = {
		name,
		cloneFrom,
		description,
	};
	apigateway.createRestApi(
		params, (err, data) => {
			if (err) {
				console.log(err, err.stack);
				return;
			}

			const updatedConfig = JSON.stringify(
				Object.assign(
					{}, projectConfig, {
						['x-api-gateway']: Object.assign({}, projectConfig['x-api-gateway'], {'rest-api-id': data.id})
					}
				),
				null,
				2
			);

			fs.writeFile(
				config, updatedConfig, (err) => {
					if (err) {
						throw err;
					}

					console.log('Success! Now you can push your REST API using update command.');
				}
			);
		}
	);
}

function update({config, stdout}) {
	const projectConfig = loadConfig(config);

	if (!projectConfig['x-api-gateway'] || !projectConfig['x-api-gateway']['rest-api-id']) {
		throw new Error('Missing REST API id, you might want to use create command first.');
	}

	const restApiId = projectConfig['x-api-gateway']['rest-api-id'];

	const renderMethod = (name, {description, ['x-api-gateway']: {parameters}}) => {
		const template = projectConfig['x-api-gateway']['swagger-func-template'];
		return defaultsDeep(
			{
				description,
				['x-amazon-apigateway-integration']: {
					httpMethod: 'POST',
					uri:        template['x-amazon-apigateway-integration'].uri.replace(
						'{{functionName}}',
						`${projectConfig.name}_${name}`
					),
				},
				parameters,
			},
			template
		);
	};

	const renderPaths = (functions) => {
		const paths = {};

		functions.map(
			({name, definition}) => {

				const {path, method} = definition['x-api-gateway'];
				if (!path || !method) {
					return;
				}

				paths[path]         = paths[path] || {};
				paths[path][method] = renderMethod(name, definition);
			}
		);

		entries(projectConfig['x-api-gateway']['paths']).forEach(
			([key, value]) => {
				const keyPattern   = new RegExp(`^${key}$`);
				const matchedPaths = entries(paths).filter(([path]) => keyPattern.test(path));

				matchedPaths.forEach(
					([path, pathValue]) => {
						defaultsDeep(pathValue, value); // paths local mutation seems to be the best
					}
				);
			}
		);

		return paths;
	};

	const functionsDefs = fs
		.readdirSync(path.join(process.cwd(), './functions'))
		.map(
			(folder) => {

				try {
					const functionDef = require(path.join(process.cwd(), `./functions/${folder}/function.json`));

					return {
						name:       folder,
						definition: functionDef,
					};
				} catch (e) {
					return;
				}
			}
		);

	const swagger = {
		"swagger":             "2.0",
		"info":                {
			"version": (new Date()).toISOString(),
			"title":   projectConfig.name,
		},
		"basePath":            projectConfig['x-api-gateway'].base_path,
		"schemes":             [
			"https"
		],
		"paths":               renderPaths(functionsDefs),
		"securityDefinitions": {
			"api_key": {
				"type": "apiKey",
				"name": "x-api-key",
				"in":   "header"
			}
		},
		"definitions":         {
			"Empty": {
				"type": "object"
			}
		}
	};

	if (stdout) {
		fs.writeFile(
			'swagger.json', JSON.stringify(swagger), (err) => {
				if (err) {
					throw err;
				}

				console.log('Success! You can now view your swaggger file locally');
			}
		);
		return;
	}

	console.log('Pushing REST API...');

	const params = {
		body: JSON.stringify(swagger),
			  restApiId,
		mode: 'overwrite',
	};
	apigateway.putRestApi(
		params, (err, data) => {
			
			if (err) {
				console.log(err, err.stack);
				return;
			}

			console.log('Updated API with success!');
			console.log('Deploying REST API...');

			const params = {
				restApiId,
				stageName: projectConfig['x-api-gateway']['stage_name'],
			};

			apigateway.createDeployment(
				params, (err, data) => {
					if (err) {
						console.log(err, err.stack);
						return;
					}

					console.log('API deployed successfully!');

					functionsDefs.map(
						({name, definition}) => {

							var params = {
								Action:       'lambda:InvokeFunction',
								FunctionName: projectConfig.name + '_' + name,
								Principal:    'apigateway.amazonaws.com',
								StatementId:  MAKE A UUID,
								// EventSourceToken: 'STRING_VALUE',
								// 	Qualifier: 'STRING_VALUE',
								// 	SourceAccount: 'STRING_VALUE',
								SourceArn:    'arn:aws:execute-api:eu-west-2:' + projectConfig['account-id']+':'
											  + projectConfig['x-api-gateway']['rest-api-id']
											  + '/*/*/'
											  // + definition['x-api-gateway'].method.toUpperCase()
											  // + definition['x-api-gateway'].path
							};

							lambda.addPermission(
								params, (err, data) => {

									if (!!err) {

										console.log(err, err.stack);
										return;
									}

									console.log('API successfully granted access to lambda functions!');
								}
							);
						}
					)
				}
			);
		}
	);
}

function loadConfig(projectFile = './project.json') {
	return require(path.join(process.cwd(), projectFile));
}
