(function(window) {
	"use strict";

	if (!window.AudioContext) { return; }

	// defineAudioProperty()
	// defineAudioProperties()

	var automatorMap = new WeakMap();

	var defaults = {
	    	duration: 0.008
	    };

	var features = {};

	var ramps = {
	    	'step': stepRamp,
	    	'linear': linearRamp,
	    	'exponential': exponentialRamp
	    };

	var map = Function.prototype.call.bind(Array.prototype.map);

	function noop() {}

	function isDefined(value) {
		return value !== undefined && value !== null;
	}

	function toType(object) {
		return typeof object;
	}

	function extend(object1, object2) {
		Object.keys(object2).forEach(function(key) {
			object1[key] = object2[key];
		});
	}

	function isAudioNode(object) {
		return window.AudioNode.prototype.isPrototypeOf(object);
	}

	function isAudioParam(object) {
		return window.AudioParam && window.AudioParam.prototype.isPrototypeOf(object);
	}

	function testDisconnectParameters() {
		var audio = new AudioContext();

		try {
			// This will error if disconnect(parameters) is
			// supported.
			audio.createGain().disconnect(audio.destination);
			return false;
		} catch (error) { 
			return true;  
		}
	}

	function registerAutomator(object, name, fn) {
		var automators = automatorMap.get(object) || (automatorMap.set(object, {}));
		automators[name] = fn;
	}

	function stepRamp(param, n, time, duration) {
		param.setValueAtTime(n, time);
	}

	function linearRamp(param, n, time, duration) {
		param.setValueAtTime(param.value, time);
		param.linearRampToValueAtTime(n, time + duration);
	}

	function exponentialRamp(param, n, time, duration) {
		param.setValueAtTime(param.value, time);
		param.exponentialRampToValueAtTime(n, time + duration);
	}

	function rampToValue(param, value, time, duration, curve) {
		// Curve defaults to 'step' where a duration is 0 or not defined, and
		// otherwise to 'linear'.
		curve = duration === 0 || duration === undefined ? 'step' : curve || 'linear' ;
		param.cancelScheduledValues(time);
		ramps[curve](param, value, time, duration);
	}

	function defineAudioProperty(object, name, audio, data) {
		var param = isAudioParam(data) ? data : data.param ;

		if (param ? !isAudioParam(param) : (!data.set || !data.get)) {
			throw new Error(
				'AudioObject.defineAudioProperty requires EITHER data.param to be an AudioParam' + 
				'OR data.set and data.get to be defined as functions.'
			);
		}

		var set = param ?
		    	function set(value, time, duration, curve) {
		    		rampToValue(param, value, time, duration, curve);
		    	} :
		    	data.set.bind(object) ;

		var get = param ?
		    	function get() { return param.value; } :
		    	data.get.bind(object) ;

		var value = get();

		var message = {
		    	type: 'update',
		    	name: name
		    };

		function update(val) {
			// Set the old value of the message to the current value before
			// updating the value.
			message.oldValue = value;
			value = val;

			// Update the observe message and send it.
			if (Object.getNotifier) {
				Object.getNotifier(object).notify(message);
			}
		}

		function frame() {
			// Stop updating if value has reached param value
			if (value === get()) { return; }

			// Castrate the calls to automate the value, then call the setter
			// with the param's current value. Done like this, where the setter
			// has been redefined externally it nonetheless gets called with
			// automated values.
			var _automate = automate;

			automate = noop;
			object[name] = get();
			automate = _automate;

			window.requestAnimationFrame(frame);
		}

		function automate(value, duration, curve) {
			set(value, audio.currentTime, duration || data.duration || defaults.duration, curve || data.curve);
			window.requestAnimationFrame(frame);
		}

		registerAutomator(object, name, automate);

		Object.defineProperty(object, name, {
			// Return value because we want values that have just been set
			// to be immediately reflected by get, to be coherent.
			get: function() { return value; },

			set: function(val) {
				// Create a new notify message and update the value.
				update(val);
				automate(val);
			},

			enumerable: isDefined(data.enumerable) ? data.enumerable : true,
			configurable: isDefined(data.configurable) ? data.configurable : true
		});

		return object;
	}

	function defineAudioProperties(object, audio, data) {
		// Define params as getters/setters
		var name;

		for (name in data) {
			AudioObject.defineAudioProperty(object, name, audio, data[name]);
		}

		return object;
	}



	// AudioObject()

	var inputs = new WeakMap();
	var outputs = new WeakMap();
	var connectionMap = new WeakMap();

	function createConnections(object) {
		var output = outputs.get(object);
		var n = output.numberOfOutputs;
		var connections = [];
		while (n--) { connections.push(new Map()); }
		return connections;
	}

	function getConnections(source) {
		var connections = connectionMap.get(source);

		if (!connections) {
			connections = createConnections(source);
			connectionMap.set(source, connections);
		}

		return connections;
	}

	function setChannelConnection(connections, destination, channel) {
		var array = connections.get(destination);

		if (!array) {
 			array = [];
 			connections.set(destination, array);
		}

		if (array.indexOf(channel) === -1) {
			array.push(channel);
		}
	}

	function clearChannelConnection(connections, destination, channel) {
		if (!destination) {
			connections.clear();
			return;
		}

		if (!isDefined(channel)) {
			connections.delete(destination);
		}

		var array = connections.get(destination);
		var i = array.indexOf(channel);

		if (i === -1) { return; }

		array.splice(i, 1);
	}

	function setConnection(source, destination, outNumber, inNumber) {
		var connections = getConnections(source);

		if (isDefined(outNumber)) {
			setChannelConnection(connections[outNumber], destination, inNumber);
			return;
		}

		var chan = connections.length;

		while (chan--) {
			setChannelConnection(connections[chan], destination, chan);
		}
	}

	function removeConnection(source, destination, outNumber, inNumber) {
		var connections = getConnections(source);

		if (isDefined(outNumber)) {
			clearChannelConnection(connections[outNumber], destination, outNumber);
			return;
		}

		var chan = connections.length;

		while (chan--) {
			connections[chan].delete(destination);
		}
	}

	function disconnectDestination(source, output, input, outNumber, inNumber) {
		var connections = getConnections(source);
		var n = connections.length;
		var map, destination, array, i;

		output.disconnect();

		// Reconnect destinations apart from input
		while (n--) {
			for (map of connections[n]) {
				destination = map[0];
				array = map[1];

				if (destination === input) { continue; }

				i = array.length;
				while (i--) {
					output.connect(destination, n, array[i]);
				}
			}
		}
	}

	function connect(source, outName, outNumber, destination, inName, inNumber) {
		// Support both AudioObjects and native AudioNodes.
		var inputs, inNode;

		if (isAudioNode(destination)) {
			inNode = destination;

			//if (inName) {
			//	console.warn('AudioObject: trying to .connect() but destination is an AudioNode, and cannot have an input named "' + inName + '".');
			//}
		}
		else {
			inputs = AudioObject.inputs.get(destination);

			if (!inputs) {
				console.warn('AudioObject: trying to .connect() an object with no inputs.', destination);
			}

			inNode = inputs[inName];

			if (!inNode) {
				console.warn('AudioObject: trying to .connect() but input node "' + inName + '" not found.', inputs);
			}
		}

		var outputs = AudioObject.outputs.get(source);

		if (!outputs) {
			console.warn('AudioObject: trying to .connect() from an object without outputs.', source);
			return;
		}

		var node1 = outputs[outName];

		if (isDefined(outNumber) && isDefined(inNumber)) {
			if (outNumber >= node1.numberOfOutputs) {
				console.warn('AudioObject: Trying to .connect() from a non-existent output (' +
					outNumber + ') on output node {numberOfOutputs: ' + node1.numberOfOutputs + '}. Dropping connection.');
				return;
			}

			if (inNumber >= inNode.numberOfInputs) {
				console.warn('AudioObject: Trying to .connect() to a non-existent input (' +
					inNumber + ') on input node {numberOfInputs: ' + inNode.numberOfInputs + '}. Dropping connection.');
				return;
			}

			node1.connect(inNode, outNumber, inNumber);
			setConnection(source, inNode, outNumber, inNumber);
		}
		else {
			node1.connect(inNode);
			setConnection(source, inNode);
		}
	}

	function disconnect(source, outName, outNumber, destination, inName, inNumber) {
		var outputs = AudioObject.outputs.get(source);

		if (!outputs) {
			console.warn('AudioObject: trying to .disconnect() from an object without outputs.', source);
			return;
		}

		var outNode = outputs[outName];

		if (!outNode) {
			console.warn('AudioObject: trying to .disconnect() but output node "' + outName + '" not found.', outputs);
			return;
		}

		if (!destination) {
			outNode.disconnect();
			removeConnection(source);
			return;
		}

		var inputs, inNode;

		if (isAudioNode(destination)) {
			inNode = destination;

			//if (inName) {
			//	console.warn('AudioObject: trying to .disconnect() but destination is an AudioNode, and cannot have an input named "' + inName + '".');
			//}
		}
		else {
			inputs = AudioObject.inputs.get(destination);

			if (!inputs) {
				console.warn('AudioObject: trying to .disconnect() an object with no inputs.');
			}

			inNode = inputs[inName];

			if (!inNode) {
				console.warn('AudioObject: trying to .disconnect() but input node "' + inName + '" not found.', inputs);
			}
		}

		if (features.disconnectParameters) {
			outNode.disconnect(inNode, outNumber, inNumber);
		}
		else {
			disconnectDestination(source, outNode, inNode, outNumber, inNumber);
		}

		removeConnection(source, inNode, outNumber, inNumber);
	}

	function isAudioObject(object) {
		return prototype.isPrototypeOf(object);
	}

	function AudioObject(audio, input, output, params) {
		if (this === undefined || this === window || this.connect !== prototype.connect) {
			// If this is undefined the constructor has been called without the
			// new keyword, or without a context applied. Do that now.
			return new AudioObject(audio, input, output, params);
		}

		if (!(input || output)) {
			throw new Error('AudioObject: new AudioObject() must be given an input OR output OR both.');
		}

		// Keep a map of input and output nodes without exposing them.
		if (input) {
			AudioObject.inputs.set(this, isAudioNode(input) ?
				{ default: input } :
				extend({}, input)
			);
		}

		if (output) {
			AudioObject.outputs.set(this, isAudioNode(output) ?
				{ default: output } :
				extend({}, output)
			);
		}
		else {
			this.connect = this.disconnect = noop;
		}

		// Define Audio Params as getters/setters
		if (params) {
			AudioObject.defineAudioProperties(this, audio, params);
		}

		Object.defineProperty(this, 'context', { value: audio });
	}

	var prototype = {
		automate: function(name, value, time, curve) {
			var automators = automatorMap.get(this);
			if (!automators) {
				// Only properties that have been registered
				// by defineAudioProperty() can be automated.
				throw new Error('AudioObject: property ' + name + ' is not automatable.');
				return;
			}

			var fn = automators[name];
			if (!fn) {
				// Only proerties that have been registered
				// by defineAudioProperty() can be automated.
				throw new Error('AudioObject: property ' + name + ' is not automatable.');
				return;
			}

			fn(value, time, curve);
		},

		connect: function(outName, outNumber, destination, inName, inNumber) {
			var signature = map(arguments, toType).join(' ');

			switch (signature) {
				case 'object':
					connect(this, 'default', undefined, arguments[0], 'default');
					break;
				case 'object string':
				case 'object string number':
					connect(this, 'default', undefined, arguments[0], arguments[1], arguments[2]);
					break;
				case 'object number':
				case 'object number number':
					connect(this, 'default', arguments[1], arguments[0], 'default', arguments[2]);
					break;
				case 'string object':
				case 'string object number':
					connect(this, arguments[0], undefined, arguments[1], 'default', arguments[2]);
					break;
				case 'string object string':
				case 'string object string number':
					connect(this, arguments[0], undefined, arguments[1], arguments[2], arguments[3]);
					break;
				default:
					connect(this, outName, outNumber, destination, inName, inNumber);
			}

			return this;
		},

		disconnect: function(outName, outNumber, destination, inName, inNumber) {
			// In a nutshell, the AudioNode spec boils down to:
			// .disconnect([AudioNode || AudioParam], [outNumber], [inNumber])
			// All parameters are optional, although some combinations are
			// not supported. Here's those that are:
			//
			// .disconnect()
			// .disconnect(output)
			// .disconnect(AudioNode, output)
			// .disconnect(AudioNode, output, input)
			// .disconnect(AudioParam)
			// .disconnect(AudioParam, output)

			var signature = map(arguments, toType).join(' ');

			switch (signature) {
				case '':
					connect(this, 'default');
					break;
				case 'object':
					disconnect(this, 'default', undefined, arguments[0], 'default');
					break;
				case 'object string':
				case 'object string number':
					disconnect(this, 'default', undefined, arguments[0], arguments[1], arguments[2]);
					break;
				case 'object number':
				case 'object number number':
					disconnect(this, 'default', arguments[1], arguments[0], 'default', arguments[2]);
					break;
				case 'string object':
				case 'string object number':
					disconnect(this, arguments[0], undefined, arguments[1], 'default', arguments[2]);
					break;
				case 'string object string':
				case 'string object string number':
					disconnect(this, arguments[0], undefined, arguments[1], arguments[2], arguments[3]);
					break;
				default:
					disconnect(this, outName, outNumber, destination, inName, inNumber);
			}

			return this;
		},

		destroy: noop
	};

	// Extend AudioObject.prototype
	extend(AudioObject.prototype, prototype);

	// Feature tests
	features.disconnectParameters = testDisconnectParameters();

	AudioObject.inputs = inputs;
	AudioObject.outputs = outputs;
	AudioObject.features = features;
	AudioObject.connections = connectionMap;
	AudioObject.automate = rampToValue;
	AudioObject.defineAudioProperty = defineAudioProperty;
	AudioObject.defineAudioProperties = defineAudioProperties;
	AudioObject.isAudioObject = isAudioObject;

	window.AudioObject = AudioObject;
})(window);
